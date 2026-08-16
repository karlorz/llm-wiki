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
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collectClaimedTranscripts,
  safeDiagnosticValue,
  REDACTED_MALFORMED_REFERENCE,
  type ClaimField,
} from "../utils/transcript-claims.js";
import { normalizeProjectSlug } from "../utils/project-slug.js";
import { parseActiveWorkPath } from "../utils/work-item-path.js";

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

  // scan.workItems is already filtered to spec|plan|log under projects/*/work/*.
  // Reuse the shared active-work parser instead of restating that path shape.
  const workItemDirs = new Set<string>();
  const specDirs = new Set<string>();
  for (const page of scanResult.data.workItems) {
    const slash = page.relPath.lastIndexOf("/");
    if (slash < 0) continue;
    const dir = page.relPath.slice(0, slash);
    if (!parseActiveWorkPath(dir)) continue;
    workItemDirs.add(dir);
    if (page.relPath.endsWith("/spec.md")) specDirs.add(dir);
  }

  const sortedDirs = [...workItemDirs].sort();
  const slugByDir = new Map(sortedDirs.map((dir) => [dir, parseActiveWorkPath(dir)?.project] as const));

  if (input.project) {
    const knownSlugs = new Set(
      [...slugByDir.values()].filter((slug): slug is string => Boolean(slug)),
    );
    if (!knownSlugs.has(input.project)) {
      return {
        exitCode: ExitCode.PROJECT_NOT_FOUND,
        result: err("UNKNOWN_PROJECT", `Project "${input.project}" not found. Available: ${[...knownSlugs].sort().join(", ") || "(none)"}`),
      };
    }
  }

  const scopedSpecDirs = sortedDirs.filter((relDir) => {
    if (!specDirs.has(relDir)) return false;
    return !input.project || slugByDir.get(relDir) === input.project;
  });
  const claimSourceResults = await mapWithConcurrency(scopedSpecDirs, vaultIoConcurrency(), async (relDir) => {
    const specPath = join(input.vault, relDir, "spec.md");
    try {
      const specText = await readFile(specPath, "utf8");
      const fm = extractFrontmatter(specText);
      if (!fm.ok) return null;
      return {
        relDir,
        source: fm.data.source,
        sources: fm.data.sources,
        closes: fm.data.closes,
      };
    } catch {
      return null;
    }
  });
  const claimIndex = collectClaimedTranscripts(
    claimSourceResults.filter((source): source is NonNullable<typeof source> => source !== null),
  );
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
  const transcriptEntries = await mapWithConcurrency(activeTranscripts, vaultIoConcurrency(), async (t) => {
    try {
      const text = await readPageCached(t);
      const fm = extractFrontmatter(text);
      if (!fm.ok) return null;
      const projectRaw = typeof fm.data.project === "string" ? fm.data.project.trim() : undefined;
      const workItemRaw = typeof fm.data.work_item === "string" ? fm.data.work_item.trim() : undefined;
      const meta: TranscriptMeta = {};
      if (projectRaw) {
        meta.projectRaw = projectRaw;
        meta.project = normalizeProjectSlug(projectRaw);
      }
      if (workItemRaw) meta.workItem = workItemRaw;
      return [t.relPath, meta] as const;
    } catch {
      return null;
    }
  });
  for (const entry of transcriptEntries) {
    if (entry) transcriptMeta.set(entry[0], entry[1]);
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
    const ownerProject = slugByDir.get(owner) ?? parseActiveWorkPath(owner)?.project;
    if (meta?.project && ownerProject !== meta.project) {
      findings.push({
        kind: "project_mismatch",
        path,
        captureProject: safeProjectPresentation(meta.projectRaw ?? ""),
        claimedByProject: ownerProject ?? "",
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

  // Single typed counting + hint pass; findings retain deterministic append
  // order so the summary counts never reorder them.
  const summary: ClaimsAuditSummary = {
    duplicate_claim: 0,
    malformed_claim_reference: 0,
    dangling_claim_reference: 0,
    project_mismatch: 0,
    work_item_unbacked_claim: 0,
  };
  const hintLines: string[] = [];
  for (const f of findings) {
    summary[f.kind] += 1;
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
