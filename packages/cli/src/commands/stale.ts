import { readdir, rename, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency, type PageTextCache, type VaultScan } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { parseExpiryAnnotations, type ExpiryAnnotation } from "../parsers/expiry-annotations.js";
import { appendLastOp } from "../utils/last-op.js";
import { lifecycleDestination } from "../utils/raw-operation-policy.js";
import { applyRawStructuralMove, planRawStructuralMove } from "../utils/raw-structural-transaction.js";
import { operationId } from "../utils/operation-id.js";
import { buildSourceReferenceIndex } from "../utils/source-reference-index.js";
import { buildSourceRelocationProjection, readSourceRelocations } from "../utils/source-relocations.js";
import { collectClaimedTranscripts } from "../utils/transcript-claims.js";
import { normalizeProjectSlug } from "../utils/project-slug.js";
import { parseActiveWorkPath } from "../utils/work-item-path.js";

export interface StaleInput { vault: string; days: number; archive?: boolean; apply?: boolean; approve?: string; forceScan?: boolean; project?: string; scan?: VaultScan; pageTextCache?: PageTextCache }
export interface StaleTranscript { path: string; reason: string; hint?: string }
export interface IncompleteWorkItem { path: string; reason: string }
export interface StaleSection {
  page: string;
  heading: string;
  line: number;
  expires: string;
  refresh?: "weekly" | "monthly" | "quarterly";
  source?: string;
  reason: string;
}

export interface StaleOutput {
  stale: Array<{ page: string; reason: string }>;
  stale_transcripts: StaleTranscript[];
  unclaimed_transcripts: StaleTranscript[];
  incomplete_work_items: IncompleteWorkItem[];
  done_work_items: IncompleteWorkItem[];
  stale_sections: StaleSection[];
  archived: string[];
  planned_archives?: Array<{ from: string; to: string }>;
  approval_token?: string;
  humanHint: string;
}

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - Date.parse(isoDate)) / 86400000);
}

export async function runStale(input: StaleInput): Promise<{ exitCode: number; result: Result<StaleOutput> }> {
  const scanResult = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };
  const scan = scanResult.data;

  const staleTranscripts: StaleTranscript[] = [];
  const incompleteWorkItems: IncompleteWorkItem[] = [];
  const archived: string[] = [];

  // Discover work directories and their statuses
  const workDirs = new Map<string, string>(); // relDir -> status | ""
  const projectsDir = join(input.vault, "projects");
  let projectSlugs: string[] = [];
  try { projectSlugs = (await readdir(projectsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no projects */ }

  // --project: scope to a single project
  if (input.project) {
    if (!projectSlugs.includes(input.project)) {
      return { exitCode: ExitCode.USAGE, result: { ok: false, error: "UNKNOWN_PROJECT", detail: `Project "${input.project}" not found. Available: ${projectSlugs.join(", ") || "(none)"}` } };
    }
    projectSlugs = [input.project];
  }

  for (const slug of projectSlugs) {
    const workPath = join(projectsDir, slug, "work");
    let entries;
    try { entries = await readdir(workPath, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const relDir = `projects/${slug}/work/${e.name}`;
      const absDir = join(workPath, e.name);
      let status = "";
      let files: string[];
      try { files = await readdir(absDir); } catch { workDirs.set(relDir, ""); continue; }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        try {
          const fm = extractFrontmatter(await readFile(join(absDir, f), "utf8"));
          if (fm.ok && typeof fm.data.status === "string") { status = fm.data.status; break; }
        } catch { /* skip */ }
      }
      workDirs.set(relDir, status);
    }
  }

  // Helper: extract project slug from frontmatter project field ("[[slug]]" → "slug")
  function extractSlug(projectField: string): string {
    return normalizeProjectSlug(projectField) ?? "";
  }

  // Terminal statuses that indicate work is finished (Zod schema: completed | abandoned; legacy: done | invalid)
  const TERMINAL_STATUSES = new Set(["completed", "abandoned", "done", "invalid"]);

  // Helper: infer kind from filename pattern YYYY-MM-DD-{kind}-{slug}.md
  const KIND_FROM_FILENAME = /^(?:\d{4}-\d{2}-\d{2})-(task|bug|idea|note|observation)-.+\.md$/;
  const LOOP_CYCLE_PATTERN = /loop-cycle-/;

  // 1. Stale transcripts: raw/transcripts/*.md where matching work item is done/invalid
  const transcripts = scan.raw.filter(p => p.relPath.startsWith("raw/transcripts/") && p.relPath.endsWith(".md"));

  // Pre-parse transcript frontmatter for project/kind fields
  const transcriptMeta = new Map<string, { kind: string; project: string; slug: string; inferred: boolean }>();
  const transcriptEntries = await mapWithConcurrency(transcripts, vaultIoConcurrency(), async (t) => {
    try {
      const content = await readPageCached(t, input.pageTextCache);
      const fm = extractFrontmatter(content);
      let kind = fm.ok && typeof fm.data.kind === "string" ? fm.data.kind : "";
      let project = fm.ok && typeof fm.data.project === "string" ? fm.data.project : "";

      // --project: skip transcripts not exactly linked to this project
      if (input.project && normalizeProjectSlug(project) !== input.project) return null;
      let inferred = false;

      // Force-scan: infer kind from filename if missing (skip loop-cycle session logs)
      if (input.forceScan && !kind) {
        const basename = t.relPath.split("/").pop()!;
        if (!LOOP_CYCLE_PATTERN.test(basename)) {
          const m = basename.match(KIND_FROM_FILENAME);
          if (m) { kind = m[1]!; inferred = true; }
        }
      }

      // Force-scan: infer project from content if missing
      if (input.forceScan && !project && kind) {
        // Search for [[slug]] wikilink in body (skip frontmatter)
        const bodyStart = content.indexOf("---", 4);
        if (bodyStart > 0) {
          const body = content.slice(bodyStart);
          const wikilink = body.match(/\[\[([a-z0-9-]+)\]\]/);
          if (wikilink) {
            const candidate = wikilink[1]!;
            // Verify this is a known project slug
            if (projectSlugs.includes(candidate)) {
              project = `[[${candidate}]]`;
              inferred = true;
            }
          }
        }
      }

      return [t.relPath, { kind, project, slug: extractSlug(project), inferred }] as const;
    } catch {
      return null;
    }
  });
  for (const entry of transcriptEntries) {
    if (entry) transcriptMeta.set(entry[0], entry[1]);
  }

  // 1. Exact claims: transcripts referenced by work item spec frontmatter
  // (`source:`, `sources:`, or `closes:`). Ownership comes only from an exact
  // vault-relative raw/transcripts path reference, never from dates, slugs,
  // titles, or filename similarity.
  const claimSources = await mapWithConcurrency([...workDirs.keys()], vaultIoConcurrency(), async (relDir) => {
    const specPath = join(input.vault, relDir, "spec.md");
    try {
      const specContent = await readFile(specPath, "utf8");
      const specFm = extractFrontmatter(specContent);
      if (!specFm.ok) return null;
      return {
        relDir,
        source: specFm.data.source,
        sources: specFm.data.sources,
        closes: specFm.data.closes,
      };
    } catch { /* no spec or unreadable */ }
    return null;
  });
  const claimedByPath = collectClaimedTranscripts(
    claimSources.filter((source): source is NonNullable<typeof source> => source !== null),
  ).claimedByPath;
  for (const [transcriptPath, workDir] of claimedByPath) {
    const status = workDirs.get(workDir) ?? "";
    if (TERMINAL_STATUSES.has(status)) {
      staleTranscripts.push({ path: transcriptPath, reason: `work item ${workDir} is ${status}` });
    }
  }

  // 2. Unclaimed transcripts: kind=task|bug with project field but no exact
  // work item reference
  const unclaimedTranscripts: StaleTranscript[] = [];
  const CLAIMABLE_KINDS = new Set(["task", "bug"]);
  for (const t of transcripts) {
    if (claimedByPath.has(t.relPath)) continue;
    const meta = transcriptMeta.get(t.relPath);
    if (!meta) continue;
    if (CLAIMABLE_KINDS.has(meta.kind) && meta.project) {
      const projectSlug = extractSlug(meta.project);
      const hint = `skillwiki claim ${t.relPath} --project ${projectSlug}`;
      unclaimedTranscripts.push({ path: t.relPath, reason: `${meta.kind} for ${meta.project} — no work item`, hint });
    }
  }

  // 2. Incomplete work items + done work items lingering in work/
  const doneWorkItems: IncompleteWorkItem[] = [];
  for (const [relDir, status] of workDirs) {
    const dirName = relDir.split("/").pop()!;
    const dateStr = dirName.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
    if (daysSince(dateStr) < input.days) continue;
    let files: string[];
    try { files = await readdir(join(input.vault, relDir)); } catch { continue; }
    const hasSpec = files.includes("spec.md"), hasPlan = files.includes("plan.md"), hasWI = files.includes("work-item.md");
    if (TERMINAL_STATUSES.has(status)) {
      doneWorkItems.push({ path: relDir, reason: `${status || "completed"} — should be archived` });
    } else if (hasSpec && !hasPlan) {
      incompleteWorkItems.push({ path: relDir, reason: "has spec but no plan" });
    } else if (hasWI && !hasSpec && !hasPlan) {
      incompleteWorkItems.push({ path: relDir, reason: "only work-item.md, no spec or plan" });
    }
  }

  // 3. Stale typed-knowledge pages: pages with `updated` older than --days
  const stale: Array<{ page: string; reason: string }> = [];
  const stalePageResults = await mapWithConcurrency(scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
    try {
      const text = await readPageCached(page, input.pageTextCache);
      const fm = extractFrontmatter(text);
      if (fm.ok && typeof fm.data.updated === "string") {
        // --project: only include pages exactly linked to this project
        if (input.project) {
          const pp = fm.data.provenance_projects;
          const linked = Array.isArray(pp) && pp.some((p: unknown) => normalizeProjectSlug(p) === input.project);
          if (!linked) return null;
        }
        const age = daysSince(fm.data.updated);
        // Use stale_ttl from frontmatter if present, otherwise global --days
        const threshold = (typeof fm.data.stale_ttl === "number" && fm.data.stale_ttl > 0) ? fm.data.stale_ttl : input.days;
        if (age >= threshold) {
          return { page: page.relPath, reason: `updated ${age} days ago (threshold: ${threshold})` };
        }
      }
    } catch { /* skip unreadable pages */ }
    return null;
  });
  stale.push(...stalePageResults.filter((item): item is { page: string; reason: string } => item !== null));

  // 3b. Stale sections: typed-knowledge pages with expired <!-- expires: YYYY-MM-DD --> annotations
  const staleSections: StaleSection[] = [];
  const staleSectionResults = await mapWithConcurrency(scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
    const pageSections: StaleSection[] = [];
    try {
      const text = await readPageCached(page, input.pageTextCache);
      // --project: only include pages linked to this project
      const projectFilter = input.project;
      if (projectFilter) {
        const fm = extractFrontmatter(text);
        if (fm.ok) {
          const pp = fm.data.provenance_projects;
          const linked = Array.isArray(pp) && pp.some((p: unknown) => normalizeProjectSlug(p) === projectFilter);
          if (!linked) return pageSections;
        }
      }
      const annotations = parseExpiryAnnotations(text, page.relPath);
      for (const ann of annotations) {
        if (daysSince(ann.expires) >= 0) {
          pageSections.push({
            page: ann.page,
            heading: ann.heading,
            line: ann.line,
            expires: ann.expires,
            refresh: ann.refresh,
            source: ann.source,
            reason: `section "${ann.heading}" expired on ${ann.expires}`,
          });
        }
      }
    } catch { /* skip unreadable pages */ }
    return pageSections;
  });
  staleSections.push(...staleSectionResults.flat());

  // 4. Archive if requested
  const today = new Date().toISOString().slice(0, 10);
  if (input.archive) {
    const archiveDir = join(input.vault, "_archive", today);
    // Protect any raw source referenced by typed knowledge or other maintained
    // Markdown, using the same canonical parser and relocation projection as
    // inventory, disposal, and audit surfaces.
    const relocations = await readSourceRelocations(input.vault);
    if (!relocations.ok) return { exitCode: ExitCode.WRITE_FAILED, result: relocations };
    const typedPaths = new Set(scan.typedKnowledge.map(page => page.relPath));
    const references = await buildSourceReferenceIndex({
      typedPages: scan.typedKnowledge,
      otherPages: scan.allMarkdown.filter(page => !typedPaths.has(page.relPath) && !page.relPath.startsWith("raw/")),
      availableRawPaths: scan.raw.map(page => page.relPath),
      relocationProjection: buildSourceRelocationProjection(relocations.data),
    });
    const citedRawPaths = new Set([
      ...references.integratedBy.keys(),
      ...references.referencedElsewhereBy.keys(),
    ]);
    const rawPlans: Array<{ from: string; to: string; approval: string; sourceSha256: string }> = [];
    for (const t of staleTranscripts) {
      // Never archive raw files that are cited as sources (N9: raw immutability)
      if (citedRawPaths.has(t.path) || citedRawPaths.has(t.path.replace(/\.md$/, ""))) continue;
      const destination = lifecycleDestination(t.path, "archive");
      if (!destination.ok) return { exitCode: ExitCode.WRITE_FAILED, result: destination };
      const plan = await planRawStructuralMove({ vault: input.vault, operation: "archive", source: t.path, destination: destination.data });
      if (!plan.ok) return { exitCode: ExitCode.WRITE_FAILED, result: plan };
      rawPlans.push({
        from: t.path,
        to: destination.data,
        approval: plan.data.approval_token,
        sourceSha256: plan.data.source_sha256,
      });
    }
    const workPlans = [...incompleteWorkItems, ...doneWorkItems].map(w => w.path).sort();
    const approvalToken = operationId("stale-archive-approval", [
      today,
      ...rawPlans.flatMap(plan => [plan.from, plan.to, plan.sourceSha256, plan.approval]),
      ...workPlans,
    ]);
    if (!input.apply) {
      const total = stale.length + staleTranscripts.length + unclaimedTranscripts.length + incompleteWorkItems.length + doneWorkItems.length + staleSections.length;
      return { exitCode: total > 0 ? ExitCode.STALE_PAGE : ExitCode.OK, result: ok({
        stale: [...stale, ...staleTranscripts.map(t => ({ page: t.path, reason: t.reason })), ...unclaimedTranscripts.map(t => ({ page: t.path, reason: t.reason })), ...incompleteWorkItems.map(w => ({ page: w.path, reason: w.reason })), ...doneWorkItems.map(w => ({ page: w.path, reason: w.reason }))],
        stale_transcripts: staleTranscripts,
        unclaimed_transcripts: unclaimedTranscripts,
        incomplete_work_items: incompleteWorkItems,
        done_work_items: doneWorkItems,
        stale_sections: staleSections,
        archived: [],
        planned_archives: rawPlans.map(plan => ({ from: plan.from, to: plan.to })),
        approval_token: approvalToken,
        humanHint: `DRY-RUN — ${rawPlans.length} raw transcript archive(s) and ${workPlans.length} work archive(s) require --apply --approve ${approvalToken}`,
      }) };
    }
    if (input.approve !== approvalToken) {
      return { exitCode: ExitCode.USAGE, result: { ok: false, error: "APPROVAL_INVALID", detail: { message: "stale archive approval does not match live state", approval_token: approvalToken } } };
    }
    await mkdir(archiveDir, { recursive: true });
    for (const plan of rawPlans) {
      const moved = await applyRawStructuralMove({
        vault: input.vault,
        operation: "archive",
        source: plan.from,
        destination: plan.to,
        approve: plan.approval,
        command: "skillwiki stale --archive --apply",
      });
      if (!moved.ok) return { exitCode: ExitCode.WRITE_FAILED, result: moved };
      archived.push(plan.from);
    }
    for (const w of [...incompleteWorkItems, ...doneWorkItems]) {
      // Work items are directories — move to project history/ dir.
      // projects/{slug}/work/{item} → projects/{slug}/history/archived-work/{item}
      const active = parseActiveWorkPath(w.path);
      if (active) {
        const { project: slug, item: itemName } = active;
        const histDir = join(input.vault, "projects", slug, "history", "archived-work");
        await mkdir(histDir, { recursive: true });
        const dest = join(histDir, itemName);
        try {
          await rename(join(input.vault, w.path), dest);
          archived.push(w.path);
        } catch (error) {
          return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { path: w.path, destination: dest, message: String(error) }) };
        }
      } else {
        // Fallback: flat archive
        const dest = join(archiveDir, w.path.replace(/\//g, "_"));
        try {
          await rename(join(input.vault, w.path), dest);
          archived.push(w.path);
        } catch (error) {
          return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { path: w.path, destination: dest, message: String(error) }) };
        }
      }
    }
  }

  if (input.archive && archived.length > 0) {
    appendLastOp(input.vault, {
      operation: "stale-archive",
      summary: `archived ${archived.length} stale items`,
      files: archived,
      timestamp: new Date().toISOString(),
    });
  }

  const total = stale.length + staleTranscripts.length + unclaimedTranscripts.length + incompleteWorkItems.length + doneWorkItems.length + staleSections.length;
  const hintLines: string[] = [];
  if (stale.length > 0) hintLines.push(`stale_pages: ${stale.length}`, ...stale.map(p => `  ${p.page}: ${p.reason}`));
  if (staleTranscripts.length > 0) hintLines.push(`stale_transcripts: ${staleTranscripts.length}`, ...staleTranscripts.map(t => `  ${t.path}: ${t.reason}`));
  if (unclaimedTranscripts.length > 0) hintLines.push(`unclaimed_transcripts: ${unclaimedTranscripts.length}`, ...unclaimedTranscripts.map(t => `  ${t.path}: ${t.reason}${t.hint ? `\n    hint: ${t.hint}` : ""}`));
  if (incompleteWorkItems.length > 0) hintLines.push(`incomplete_work_items: ${incompleteWorkItems.length}`, ...incompleteWorkItems.map(w => `  ${w.path}: ${w.reason}`));
  if (doneWorkItems.length > 0) hintLines.push(`done_work_items: ${doneWorkItems.length}`, ...doneWorkItems.map(w => `  ${w.path}: ${w.reason}`));
  if (staleSections.length > 0) hintLines.push(`stale_sections: ${staleSections.length}`, ...staleSections.map(s => `  ${s.page}#${s.heading}: ${s.reason}`));
  if (archived.length > 0) hintLines.push(`archived: ${archived.length}`, ...archived.map(a => `  ${a}`));
  if (hintLines.length === 0) hintLines.push("no stale transcripts or incomplete work items");

  return { exitCode: total > 0 ? ExitCode.STALE_PAGE : ExitCode.OK, result: ok({
    stale: [...stale, ...staleTranscripts.map(t => ({ page: t.path, reason: t.reason })), ...unclaimedTranscripts.map(t => ({ page: t.path, reason: t.reason })), ...incompleteWorkItems.map(w => ({ page: w.path, reason: w.reason })), ...doneWorkItems.map(w => ({ page: w.path, reason: w.reason }))],
    stale_transcripts: staleTranscripts, unclaimed_transcripts: unclaimedTranscripts, incomplete_work_items: incompleteWorkItems, done_work_items: doneWorkItems, stale_sections: staleSections, archived, humanHint: hintLines.join("\n")
  }) };
}
