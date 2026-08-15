/**
 * Read-only `claims audit` command (skillwiki claims audit).
 *
 * Reads the vault only and returns a stable JSON object of claim-integrity
 * findings plus a human-readable summary. This command never writes: it does
 * not use guarded-write/managed-write wrappers, does not append last-operation
 * state, does not modify files, build graphs, regenerate indexes, update
 * projections, invoke Git, synchronize, or access S3.
 *
 * Scope: active `raw/transcripts/` only; no archived mapping. Ownership comes
 * only from an exact vault-relative `raw/transcripts/...` reference in a work
 * item's `source:` / `sources:` / `closes:` frontmatter — never from dates,
 * slugs, titles, body wikilinks, filename similarity, or a project substring.
 * `--project` scopes claim-derived findings (duplicate, malformed, dangling,
 * project_mismatch) by owning work-item project; raw-capture filtering limits
 * only standalone `work_item_unbacked_claim`.
 *
 * Finding kinds:
 *  - duplicate_claim: more than one work item claims the same exact transcript path
 *  - malformed_claim_reference: a claim field holds a noncanonical raw-transcript ref
 *    (emitted value is safe single-line evidence, or {@link REDACTED_MALFORMED_REFERENCE})
 *  - dangling_claim_reference: a canonical claimed path is absent from active transcripts
 *  - project_mismatch: a capture with explicit `project` is claimed under another project
 *  - work_item_unbacked_claim: a transcript declares `work_item` with no exact claim
 */
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectClaimedTranscripts, type ClaimField } from "../utils/transcript-claims.js";
import { safeDiagnosticValue, REDACTED_MALFORMED_REFERENCE } from "../utils/transcript-claims.js";
import { normalizeProjectSlug } from "../utils/project-slug.js";

export interface ClaimsAuditInput {
  vault: string;
  project?: string;
}

interface DuplicateFinding {
  kind: "duplicate_claim";
  path: string;
  owners: string[];
}
interface MalformedFinding {
  kind: "malformed_claim_reference";
  relDir: string;
  field: ClaimField;
  /** Safe single-line attempted reference, or {@link REDACTED_MALFORMED_REFERENCE}. */
  value: string;
}
interface DanglingFinding {
  kind: "dangling_claim_reference";
  path: string;
  claimedBy: string;
}
interface ProjectMismatchFinding {
  kind: "project_mismatch";
  path: string;
  captureProject: string;
  claimedByProject: string;
  claimedBy: string;
}
interface UnbackedFinding {
  kind: "work_item_unbacked_claim";
  path: string;
  workItem: string;
}
export type ClaimsAuditFinding =
  | DuplicateFinding
  | MalformedFinding
  | DanglingFinding
  | ProjectMismatchFinding
  | UnbackedFinding;

export interface ClaimsAuditSummary {
  duplicate_claim: number;
  malformed_claim_reference: number;
  dangling_claim_reference: number;
  project_mismatch: number;
  work_item_unbacked_claim: number;
}

export interface ClaimsAuditOutput {
  findings: ClaimsAuditFinding[];
  summary: ClaimsAuditSummary;
  humanHint: string;
}

/**
 * Safe presentation of a raw frontmatter project value. Only presentation is
 * redacted: a value that `safeDiagnosticValue` deems unsafe (multiline,
 * control characters, or oversized) becomes {@link REDACTED_MALFORMED_REFERENCE};
 * a safe value is presented as its canonical normalized slug. Semantic
 * comparison always uses the normalized internal value, never this helper.
 */
function safeProjectPresentation(raw: string): string {
  if (safeDiagnosticValue(raw) === REDACTED_MALFORMED_REFERENCE) {
    return REDACTED_MALFORMED_REFERENCE;
  }
  return normalizeProjectSlug(raw) ?? REDACTED_MALFORMED_REFERENCE;
}

/** Extract the project slug owning a work-item relDir `projects/{slug}/work/{item}`. */
function workItemProject(workItemDir: string): string | undefined {
  const parts = workItemDir.split("/");
  if (parts.length >= 3 && parts[0] === "projects") return parts[1];
  return undefined;
}

export async function runClaimsAudit(
  input: ClaimsAuditInput,
): Promise<{ exitCode: number; result: Result<ClaimsAuditOutput> }> {
  const scanResult = await scanVault(input.vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };

  // Active transcripts only (raw/transcripts/*.md on disk).
  const activeTranscripts = scanResult.data.raw
    .filter((p) => p.relPath.startsWith("raw/transcripts/") && p.relPath.endsWith(".md"))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const activePathSet = new Set(activeTranscripts.map((p) => p.relPath));

  // Gather work item directories from scan (spec.md/plan.md/log.md under projects/*/work/*).
  const workItemDirs = new Set<string>();
  for (const page of scanResult.data.workItems) {
    const m = page.relPath.match(/^(projects\/[^/]+\/work\/[^/]+)\/(spec|plan|log)\.md$/);
    if (m) workItemDirs.add(m[1]);
  }

  if (input.project) {
    const knownSlugs = new Set<string>();
    for (const dir of workItemDirs) {
      const slug = workItemProject(dir);
      if (slug) knownSlugs.add(slug);
    }
    if (!knownSlugs.has(input.project)) {
      return {
        exitCode: ExitCode.PROJECT_NOT_FOUND,
        result: err("UNKNOWN_PROJECT", `Project "${input.project}" not found. Available: ${[...knownSlugs].sort().join(", ") || "(none)"}`),
      };
    }
  }

  const claimSources: Array<{ relDir: string; source: unknown; sources: unknown; closes: unknown }> = [];
  for (const relDir of [...workItemDirs].sort()) {
    const slug = workItemProject(relDir);
    if (input.project && slug !== input.project) continue;
    const specPath = join(input.vault, relDir, "spec.md");
    try {
      const specText = await readFile(specPath, "utf8");
      const fm = extractFrontmatter(specText);
      if (!fm.ok) continue;
      claimSources.push({
        relDir,
        source: fm.data.source,
        sources: fm.data.sources,
        closes: fm.data.closes,
      });
    } catch {
      /* no spec or unreadable */
    }
  }

  const claimIndex = collectClaimedTranscripts(claimSources);
  const claimedByPath = claimIndex.claimedByPath;

  // Parse active transcript frontmatter for explicit project and work_item.
  interface TranscriptMeta {
    /** Raw trimmed frontmatter project value, when present; used only to pick the safe presentation. */
    projectRaw?: string;
    /** Canonically normalized project slug for internal comparison. */
    project?: string;
    /** Raw trimmed frontmatter work_item value, when present and non-empty. */
    workItem?: string;
  }
  const transcriptMeta = new Map<string, TranscriptMeta>();
  for (const t of activeTranscripts) {
    try {
      const text = await readFile(join(input.vault, t.relPath), "utf8");
      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;
      const projectRaw = typeof fm.data.project === "string" ? fm.data.project.trim() : undefined;
      const workItemRaw = typeof fm.data.work_item === "string" ? fm.data.work_item.trim() : undefined;
      transcriptMeta.set(t.relPath, {
        ...(projectRaw !== undefined && projectRaw !== "" ? { projectRaw, project: normalizeProjectSlug(projectRaw) } : {}),
        ...(workItemRaw !== undefined && workItemRaw !== "" ? { workItem: workItemRaw } : {}),
      });
    } catch {
      /* skip unreadable */
    }
  }

  const findings: ClaimsAuditFinding[] = [];

  // 1. Duplicate + malformed from the claim index diagnostics.
  for (const d of claimIndex.diagnostics) {
    if (d.kind === "duplicate") {
      findings.push({ kind: "duplicate_claim", path: d.path, owners: d.owners });
    } else {
      findings.push({ kind: "malformed_claim_reference", relDir: d.relDir, field: d.field, value: d.value });
    }
  }

  // 2. Dangling claims (canonical claimed path absent from active transcripts).
  for (const [path, owner] of claimedByPath) {
    if (!activePathSet.has(path)) {
      findings.push({ kind: "dangling_claim_reference", path, claimedBy: owner });
    }
  }

  // 3. Project mismatch (capture has explicit project, claimed under another).
  for (const [path, owner] of claimedByPath) {
    const meta = transcriptMeta.get(path);
    if (meta?.project && workItemProject(owner) !== meta.project) {
      findings.push({
        kind: "project_mismatch",
        path,
        captureProject: safeProjectPresentation(meta.projectRaw ?? ""),
        claimedByProject: workItemProject(owner) ?? "",
        claimedBy: owner,
      });
    }
  }

  // 4. Work-item-unbacked claims (raw-capture filtering: --project limits only
  // this standalone finding, keyed on the capture's own explicit project).
  for (const t of activeTranscripts) {
    const meta = transcriptMeta.get(t.relPath);
    if (!meta?.workItem) continue;
    if (input.project && meta.project && meta.project !== input.project) continue;
    if (claimedByPath.has(t.relPath)) continue;
    findings.push({ kind: "work_item_unbacked_claim", path: t.relPath, workItem: safeDiagnosticValue(meta.workItem) });
  }

  // Single typed counting pass; findings retain deterministic append order so
  // the summary counts never reorder them.
  const summary: ClaimsAuditSummary = {
    duplicate_claim: 0,
    malformed_claim_reference: 0,
    dangling_claim_reference: 0,
    project_mismatch: 0,
    work_item_unbacked_claim: 0,
  };
  for (const f of findings) {
    switch (f.kind) {
      case "duplicate_claim": summary.duplicate_claim += 1; break;
      case "malformed_claim_reference": summary.malformed_claim_reference += 1; break;
      case "dangling_claim_reference": summary.dangling_claim_reference += 1; break;
      case "project_mismatch": summary.project_mismatch += 1; break;
      case "work_item_unbacked_claim": summary.work_item_unbacked_claim += 1; break;
    }
  }

  const hintLines: string[] = [];
  for (const f of findings) {
    if (f.kind === "duplicate_claim") hintLines.push(`duplicate_claim: ${f.path} — ${f.owners.join(", ")}`);
    else if (f.kind === "malformed_claim_reference") hintLines.push(`malformed_claim_reference: ${f.relDir} ${f.field}=${f.value}`);
    else if (f.kind === "dangling_claim_reference") hintLines.push(`dangling_claim_reference: ${f.path} — claimed by ${f.claimedBy}`);
    else if (f.kind === "project_mismatch") hintLines.push(`project_mismatch: ${f.path} — ${f.captureProject} claimed by ${f.claimedByProject}`);
    else hintLines.push(`work_item_unbacked_claim: ${f.path} — ${f.workItem}`);
  }
  if (hintLines.length === 0) hintLines.push("no claim-integrity findings");

  const humanHint = hintLines.join("\n");
  // Read-only audit: findings are reported in the JSON; the invocation always
  // succeeds so a caller can audit a dirty vault without a blocking exit code.
  return { exitCode: ExitCode.OK, result: ok({ findings, summary, humanHint }) };
}
