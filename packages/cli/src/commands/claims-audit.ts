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
 *
 * Finding kinds:
 *  - duplicate_claim: more than one work item claims the same exact transcript path
 *  - malformed_claim_reference: a claim field holds a noncanonical raw-transcript ref
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

/** Normalize a `[[slug]]` (or quoted `"[[slug]]"`) project value to the bare slug. */
function extractSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .trim()
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .replace(/^"+|"+$/g, "")
    .replace(/^'|'$/g, "");
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
    project?: string; // normalized bare slug
    workItem?: string; // raw trimmed frontmatter value
  }
  const transcriptMeta = new Map<string, TranscriptMeta>();
  for (const t of activeTranscripts) {
    try {
      const text = await readFile(join(input.vault, t.relPath), "utf8");
      const fm = extractFrontmatter(text);
      if (!fm.ok) continue;
      const project = extractSlug(fm.data.project);
      const workItemRaw = typeof fm.data.work_item === "string" ? fm.data.work_item.trim() : undefined;
      // A transcript is scoped-out of unbacked detection when --project is set
      // and the capture's explicit project (if any) differs from the scope.
      if (input.project && project && project !== input.project) continue;
      transcriptMeta.set(t.relPath, {
        ...(project !== undefined ? { project } : {}),
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
        captureProject: meta.project,
        claimedByProject: workItemProject(owner) ?? "",
        claimedBy: owner,
      });
    }
  }

  // 4. Work-item-unbacked claims.
  for (const t of activeTranscripts) {
    const meta = transcriptMeta.get(t.relPath);
    if (!meta?.workItem) continue;
    if (claimedByPath.has(t.relPath)) continue;
    findings.push({ kind: "work_item_unbacked_claim", path: t.relPath, workItem: meta.workItem });
  }

  const summary: ClaimsAuditSummary = {
    duplicate_claim: findings.filter((f) => f.kind === "duplicate_claim").length,
    malformed_claim_reference: findings.filter((f) => f.kind === "malformed_claim_reference").length,
    dangling_claim_reference: findings.filter((f) => f.kind === "dangling_claim_reference").length,
    project_mismatch: findings.filter((f) => f.kind === "project_mismatch").length,
    work_item_unbacked_claim: findings.filter((f) => f.kind === "work_item_unbacked_claim").length,
  };

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
