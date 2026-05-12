import { readdir, rename, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";

export interface StaleInput { vault: string; days: number; archive?: boolean }
export interface StaleTranscript { path: string; reason: string }
export interface IncompleteWorkItem { path: string; reason: string }
export interface StaleOutput {
  stale: Array<{ page: string; reason: string }>;
  stale_transcripts: StaleTranscript[];
  unclaimed_transcripts: StaleTranscript[];
  incomplete_work_items: IncompleteWorkItem[];
  done_work_items: IncompleteWorkItem[];
  archived: string[];
  humanHint: string;
}

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - Date.parse(isoDate)) / 86400000);
}

export async function runStale(input: StaleInput): Promise<{ exitCode: number; result: Result<StaleOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const staleTranscripts: StaleTranscript[] = [];
  const incompleteWorkItems: IncompleteWorkItem[] = [];
  const archived: string[] = [];

  // Discover work directories and their statuses, grouped by project slug
  const workDirs = new Map<string, string>(); // relDir -> status | ""
  const workDirsBySlug = new Map<string, Map<string, string>>(); // slug -> (dirName -> status)
  const projectsDir = join(input.vault, "projects");
  let projectSlugs: string[] = [];
  try { projectSlugs = (await readdir(projectsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no projects */ }

  for (const slug of projectSlugs) {
    const workPath = join(projectsDir, slug, "work");
    let entries;
    try { entries = await readdir(workPath, { withFileTypes: true }); } catch { continue; }
    const slugDirs = new Map<string, string>();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const relDir = `projects/${slug}/work/${e.name}`;
      const absDir = join(workPath, e.name);
      let status = "";
      let files: string[];
      try { files = await readdir(absDir); } catch { workDirs.set(relDir, ""); slugDirs.set(e.name, ""); continue; }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        try {
          const fm = extractFrontmatter(await readFile(join(absDir, f), "utf8"));
          if (fm.ok && typeof fm.data.status === "string") { status = fm.data.status; break; }
        } catch { /* skip */ }
      }
      workDirs.set(relDir, status);
      slugDirs.set(e.name, status);
    }
    workDirsBySlug.set(slug, slugDirs);
  }

  // Helper: extract project slug from frontmatter project field ("[[slug]]" → "slug")
  function extractSlug(projectField: string): string {
    return projectField.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/^"|"$/g, "");
  }

  // 1. Stale transcripts: raw/transcripts/*.md where matching work item is done/invalid
  const transcripts = scan.data.raw.filter(p => p.relPath.startsWith("raw/transcripts/") && p.relPath.endsWith(".md"));
  const claimedPaths = new Set<string>();

  // Pre-parse transcript frontmatter for project/kind fields
  const transcriptMeta = new Map<string, { kind: string; project: string; slug: string }>();
  for (const t of transcripts) {
    try {
      const content = await readFile(join(input.vault, t.relPath), "utf8");
      const fm = extractFrontmatter(content);
      if (fm.ok) {
        const kind = typeof fm.data.kind === "string" ? fm.data.kind : "";
        const project = typeof fm.data.project === "string" ? fm.data.project : "";
        transcriptMeta.set(t.relPath, { kind, project, slug: extractSlug(project) });
      }
    } catch { /* skip */ }
  }

  for (const t of transcripts) {
    const datePrefix = t.relPath.split("/").pop()!.slice(0, 10);
    const meta = transcriptMeta.get(t.relPath);
    const slug = meta?.slug || "";

    if (slug && workDirsBySlug.has(slug)) {
      // Project-scoped match: check slug substring, word overlap, or source: reference
      const slugDirs = workDirsBySlug.get(slug)!;
      const tSlug = t.relPath.split("/").pop()!.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "").replace(/^(task|bug|idea|note|observation)-/, "");
      for (const [dirName, status] of slugDirs) {
        if (!dirName.startsWith(datePrefix)) continue;
        const wSlug = dirName.replace(/^\d{4}-\d{2}-\d{2}-/, "");
        // Substring match (either direction) or word overlap >= 2
        const tWords = new Set(tSlug.split("-").filter(w => w.length >= 3));
        const wWords = wSlug.split("-").filter(w => w.length >= 3);
        const overlap = wWords.filter(w => tWords.has(w)).length;
        if (dirName.includes(tSlug) || tSlug.includes(wSlug) || overlap >= 1) {
          claimedPaths.add(t.relPath);
          if (status === "done" || status === "invalid") {
            staleTranscripts.push({ path: t.relPath, reason: `work item projects/${slug}/work/${dirName} is ${status}` });
          }
          break;
        }
      }
    } else if (!slug) {
      // No project field: fall back to cross-project date-prefix matching
      for (const [dir, status] of workDirs) {
        if (dir.split("/").pop()!.startsWith(datePrefix)) {
          claimedPaths.add(t.relPath);
          if (status === "done" || status === "invalid") {
            staleTranscripts.push({ path: t.relPath, reason: `work item ${dir} is ${status}` });
          }
          break;
        }
      }
    }
  }

  // 1b. Also claim transcripts referenced by work item spec.md `source:` frontmatter
  for (const [relDir] of workDirs) {
    const specPath = join(input.vault, relDir, "spec.md");
    try {
      const specContent = await readFile(specPath, "utf8");
      const specFm = extractFrontmatter(specContent);
      if (specFm.ok && typeof specFm.data.source === "string") {
        const sourcePath = specFm.data.source;
        if (sourcePath.startsWith("raw/transcripts/")) claimedPaths.add(sourcePath);
      }
    } catch { /* no spec or unreadable */ }
  }

  // 1c. Unclaimed transcripts: kind=task|bug with project field but no matching work item
  const unclaimedTranscripts: StaleTranscript[] = [];
  const CLAIMABLE_KINDS = new Set(["task", "bug"]);
  for (const t of transcripts) {
    if (claimedPaths.has(t.relPath)) continue;
    const meta = transcriptMeta.get(t.relPath);
    if (!meta) continue;
    if (CLAIMABLE_KINDS.has(meta.kind) && meta.project) {
      unclaimedTranscripts.push({ path: t.relPath, reason: `${meta.kind} for ${meta.project} — no work item` });
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
    if (status === "done") {
      doneWorkItems.push({ path: relDir, reason: "completed — should be archived" });
    } else if (status === "invalid") {
      doneWorkItems.push({ path: relDir, reason: "invalid — should be archived" });
    } else if (hasSpec && !hasPlan) {
      incompleteWorkItems.push({ path: relDir, reason: "has spec but no plan" });
    } else if (hasWI && !hasSpec && !hasPlan) {
      incompleteWorkItems.push({ path: relDir, reason: "only work-item.md, no spec or plan" });
    }
  }

  // 3. Stale typed-knowledge pages: pages with `updated` older than --days
  const stale: Array<{ page: string; reason: string }> = [];
  for (const page of scan.data.typedKnowledge) {
    try {
      const text = await readFile(join(input.vault, page.relPath), "utf8");
      const fm = extractFrontmatter(text);
      if (fm.ok && typeof fm.data.updated === "string") {
        const age = daysSince(fm.data.updated);
        if (age >= input.days) {
          stale.push({ page: page.relPath, reason: `updated ${age} days ago (threshold: ${input.days})` });
        }
      }
    } catch { /* skip unreadable pages */ }
  }

  // 4. Archive if requested
  if (input.archive) {
    const archiveDir = join(input.vault, "_archive", new Date().toISOString().slice(0, 10));
    await mkdir(archiveDir, { recursive: true });
    // Build set of raw paths cited as sources by typed-knowledge pages (protect from archival)
    const citedRawPaths = new Set<string>();
    for (const page of scan.data.typedKnowledge) {
      const text = await readFile(join(input.vault, page.relPath), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        for (const m of line.matchAll(/\^\[(raw\/[^\]]+)\]/g)) {
          citedRawPaths.add(m[1]!);
        }
        // Also check sources: frontmatter
        for (const m of line.matchAll(/raw\/[^\s,\]"]+\.md/g)) {
          citedRawPaths.add(m[0]!);
        }
      }
    }
    for (const t of staleTranscripts) {
      // Never archive raw files that are cited as sources (N9: raw immutability)
      if (citedRawPaths.has(t.path) || citedRawPaths.has(t.path.replace(/\.md$/, ""))) continue;
      const dest = join(archiveDir, t.path.split("/").pop()!);
      try { await rename(join(input.vault, t.path), dest); archived.push(t.path); } catch { /* skip */ }
    }
    for (const w of [...incompleteWorkItems, ...doneWorkItems]) {
      // Work items are directories — move to project history/ dir
      const parts = w.path.split("/");
      // projects/{slug}/work/{item} → projects/{slug}/history/archived-work/{item}
      if (parts.length >= 4 && parts[0] === "projects") {
        const slug = parts[1];
        const itemName = parts[3];
        const histDir = join(input.vault, "projects", slug, "history", "archived-work");
        await mkdir(histDir, { recursive: true });
        const dest = join(histDir, itemName);
        try { await rename(join(input.vault, w.path), dest); archived.push(w.path); } catch { /* skip */ }
      } else {
        // Fallback: flat archive
        const dest = join(archiveDir, w.path.replace(/\//g, "_"));
        try { await rename(join(input.vault, w.path), dest); archived.push(w.path); } catch { /* skip */ }
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

  const total = stale.length + staleTranscripts.length + unclaimedTranscripts.length + incompleteWorkItems.length + doneWorkItems.length;
  const hintLines: string[] = [];
  if (stale.length > 0) hintLines.push(`stale_pages: ${stale.length}`, ...stale.map(p => `  ${p.page}: ${p.reason}`));
  if (staleTranscripts.length > 0) hintLines.push(`stale_transcripts: ${staleTranscripts.length}`, ...staleTranscripts.map(t => `  ${t.path}: ${t.reason}`));
  if (unclaimedTranscripts.length > 0) hintLines.push(`unclaimed_transcripts: ${unclaimedTranscripts.length}`, ...unclaimedTranscripts.map(t => `  ${t.path}: ${t.reason}`));
  if (incompleteWorkItems.length > 0) hintLines.push(`incomplete_work_items: ${incompleteWorkItems.length}`, ...incompleteWorkItems.map(w => `  ${w.path}: ${w.reason}`));
  if (doneWorkItems.length > 0) hintLines.push(`done_work_items: ${doneWorkItems.length}`, ...doneWorkItems.map(w => `  ${w.path}: ${w.reason}`));
  if (archived.length > 0) hintLines.push(`archived: ${archived.length}`, ...archived.map(a => `  ${a}`));
  if (hintLines.length === 0) hintLines.push("no stale transcripts or incomplete work items");

  return { exitCode: total > 0 ? ExitCode.STALE_PAGE : ExitCode.OK, result: ok({
    stale: [...stale, ...staleTranscripts.map(t => ({ page: t.path, reason: t.reason })), ...unclaimedTranscripts.map(t => ({ page: t.path, reason: t.reason })), ...incompleteWorkItems.map(w => ({ page: w.path, reason: w.reason })), ...doneWorkItems.map(w => ({ page: w.path, reason: w.reason }))],
    stale_transcripts: staleTranscripts, unclaimed_transcripts: unclaimedTranscripts, incomplete_work_items: incompleteWorkItems, done_work_items: doneWorkItems, archived, humanHint: hintLines.join("\n")
  }) };
}
