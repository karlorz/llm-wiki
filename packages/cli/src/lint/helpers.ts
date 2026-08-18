import type {
  Bucket,
  LintBucketSummary,
  LintInput,
  LintOutput,
  LintReadVault,
  LintSeverity,
  LintSummaryInput,
  LintSummaryOutput,
  LintVaultOutput,
} from "./types.js";
import { appendLastOp } from "../utils/last-op.js";
import { resolveReadOnlyVaultRoot, type VaultPage } from "../utils/vault.js";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { stripFencedBlocks } from "../parsers/citations.js";

export const ERROR_ORDER = [
  "sensitive_content",
  "conflict_markers",
  "broken_wikilinks",
  "invalid_frontmatter",
  "raw_source_identity_conflict",
  "raw_dedup",
  "broken_sources",
  "tag_not_in_taxonomy",
  "path_too_long",
] as const;

export const WARNING_ORDER = [
  "raw_body_duplicate",
  "raw_subdirectory_duplicate",
  "file_source_url",
  "index_incomplete",
  "index_link_format",
  "stale_page",
  "page_too_large",
  "log_rotate_needed",
  "orphans",
  "compound_refs",
  "legacy_citation_style",
  "orphaned_citations",
  "duplicate_frontmatter",
  "frontmatter_yaml_invalid",
  "work_item_health",
  "orphaned_project_pages",
  "missing_overview",
  "missing_diagram",
] as const;

export const INFO_ORDER = [
  "bridges",
  "sparse_community",
  "page_structure",
  "topic_map_recommended",
  "frontmatter_wikilink",
  "wikilink_citation",
  "missing_tldr",
  "stale_sections",
  "cli_refs",
] as const;

export const KNOWN_BUCKETS = [...ERROR_ORDER, ...WARNING_ORDER, ...INFO_ORDER] as const;
export const CLI_REFS_TYPED_DIRS = ["entities", "concepts", "comparisons", "queries", "meta"] as const;

export const STRUCT_MIN_BODY_LINES = 60;
export const STRUCT_MIN_SECTIONS = 3;

const CANONICAL_LOCAL_SOURCE_LABEL = /^\s*(?:>\s*)?(?:[-*+]\s*)?Source (?:file|inspected):/i;
const LOCAL_ABSOLUTE_SOURCE_REF = /(?:file:\/\/(?:\/)?(?:Users|home)\/|\/(?:Users|home)\/)/;

export function hasDuplicateFrontmatter(body: string): boolean {
  if (/^---\r?\n/.test(body)) return true;
  // After splitFrontmatter, a second block's opening --- was consumed as the first block's closing ---.
  // So the body starts with the second block's YAML content, followed by its closing ---.
  // Match: a line with a YAML key (word:) then a --- line within the first 20 lines.
  const lines = body.split(/\r?\n/);
  const limit = Math.min(lines.length, 20);
  let seenYamlKey = false;
  for (let i = 0; i < limit; i++) {
    if (/^\w[\w-]*:/.test(lines[i]!.trim())) seenYamlKey = true;
    if (seenYamlKey && lines[i]!.trim() === "---") return true;
  }
  return false;
}

export function hasCanonicalLocalSourceAssertion(body: string): boolean {
  const visibleBody = stripFencedBlocks(body);
  return visibleBody.split(/\r?\n/).some((line) =>
    CANONICAL_LOCAL_SOURCE_LABEL.test(line) && LOCAL_ABSOLUTE_SOURCE_REF.test(line)
  );
}

export function shouldCheckCanonicalLocalSourceAssertion(page: VaultPage): boolean {
  if (page.relPath.startsWith("raw/transcripts/")) return false;
  if (/^projects\/[^/]+\/work\/[^/]+\/log\.md$/.test(page.relPath)) return false;
  if (page.relPath.startsWith("raw/")) return true;
  if (/^(entities|concepts|comparisons|queries|meta)\//.test(page.relPath)) return true;
  if (/^projects\/[^/]+\/compound\//.test(page.relPath)) return true;
  if (/^projects\/[^/]+\/work\/[^/]+\/(spec|plan)\.md$/.test(page.relPath)) return true;
  return false;
}

export function extractSourceEntries(rawFm: string): string[] {
  const lines = rawFm.split(/\r?\n/);
  const sourcesLineIdx = lines.findIndex((l) => /^sources:/.test(l));
  if (sourcesLineIdx === -1) return [];
  const sourcesLine = lines[sourcesLineIdx]!.trim();
  // Inline array: sources: [x, y] or sources: ["x", "y"]
  const inlineMatch = sourcesLine.match(/^sources:\s*\[(.+)]\s*$/);
  if (inlineMatch) {
    return [...inlineMatch[1]!.matchAll(/"[^"]*"|'[^']*'|[^,\s]\S*/g)].map((m) =>
      m[0].replace(/,\s*$/, "")
    );
  }
  // Multi-line YAML list: sources: followed by "  - entry" lines
  const entries: string[] = [];
  for (let i = sourcesLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s+- /.test(line)) break;
    entries.push(line.replace(/^\s+- /, "").trim());
  }
  return entries;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatExample(item: unknown): string {
  if (typeof item === "string") return item;
  if (item === null || item === undefined) return String(item);
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

export function summarizeBucket(
  bucket: Bucket,
  severity: LintSeverity,
  vaultPath: string,
  examplesLimit: number
): LintBucketSummary {
  const safeLimit = Math.max(0, Math.min(examplesLimit, 10));
  const examples = bucket.items.slice(0, safeLimit).map(formatExample);
  return {
    kind: bucket.kind,
    severity,
    count: bucket.items.length,
    examples,
    examples_limit: safeLimit,
    sample_truncated: bucket.items.length > examples.length,
    details_command: `skillwiki lint ${shellQuote(vaultPath)} --only ${bucket.kind}`,
  };
}

export function severityForBucket(kind: string): LintSeverity {
  if ((ERROR_ORDER as readonly string[]).includes(kind)) return "error";
  if ((WARNING_ORDER as readonly string[]).includes(kind)) return "warning";
  return "info";
}

export function lintReadVault(input: LintInput | LintSummaryInput): LintReadVault {
  if (input.fix) {
    return { readPath: input.vault, readMirror: false };
  }
  const resolved = resolveReadOnlyVaultRoot(input.vault);
  return { readPath: resolved.root, readMirror: resolved.mirrored };
}

export function lintVaultOutput(
  input: LintInput | LintSummaryInput,
  readVault: LintReadVault
): LintVaultOutput {
  return {
    path: input.vault,
    source: input.source ?? "resolved",
    read_path: readVault.readPath,
    read_mirror: readVault.readMirror,
  };
}

export function readMirrorHintLines(vault: LintVaultOutput): string[] {
  if (!vault.read_mirror) return [];
  return [
    `read mirror: ${vault.read_path}`,
    `requested vault: ${vault.path}`,
    "if results look stale, refresh the read mirror or rerun with SKILLWIKI_DISABLE_VAULT_READ_MIRROR=1 for a live scan; live scans may be slower",
  ];
}

export function appendLintFixLastOp(vault: string, fixed: string[]): void {
  if (fixed.length === 0) return;
  appendLastOp(vault, {
    operation: "lint-fix",
    summary: `fixed ${fixed.length} page(s)`,
    files: fixed,
    timestamp: new Date().toISOString(),
  });
}

export function summarizeLintOutput(output: LintOutput, examplesLimit = 3): LintSummaryOutput {
  const buckets = [
    ...output.by_severity.error.map((bucket) =>
      summarizeBucket(bucket, "error", output.vault.path, examplesLimit)
    ),
    ...output.by_severity.warning.map((bucket) =>
      summarizeBucket(bucket, "warning", output.vault.path, examplesLimit)
    ),
    ...output.by_severity.info.map((bucket) =>
      summarizeBucket(bucket, "info", output.vault.path, examplesLimit)
    ),
  ];
  const lines: string[] = [];
  lines.push(...readMirrorHintLines(output.vault));
  lines.push(`errors: ${output.summary.errors}`);
  lines.push(`warnings: ${output.summary.warnings}`);
  lines.push(`info: ${output.summary.info}`);
  for (const bucket of buckets) {
    lines.push(`  ${bucket.kind}: ${bucket.count}`);
    if (bucket.examples.length > 0) {
      lines.push(`    e.g. ${bucket.examples[0]}`);
    }
  }
  return {
    vault: output.vault,
    summary: output.summary,
    buckets,
    details_included: false,
    truncated: false,
    fixed: output.fixed,
    unresolved: output.unresolved,
    humanHint: lines.join("\n"),
  };
}

export async function walkMarkdownFiles(absDir: string, vaultRoot: string): Promise<VaultPage[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const pages: VaultPage[] = [];
  for (const entry of entries) {
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      pages.push(...(await walkMarkdownFiles(absPath, vaultRoot)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      pages.push({ absPath, relPath: relative(vaultRoot, absPath).split(sep).join("/") });
    }
  }
  return pages;
}

export function scanConflictMarkerBlocks(
  path: string,
  text: string
): Array<{ path: string; line: number; message: string }> {
  const findings: Array<{ path: string; line: number; message: string }> = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let openLine = 0;
  let sawSeparator = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("<<<<<<< ")) {
      openLine = i + 1;
      sawSeparator = false;
      continue;
    }
    if (line === "=======" && openLine > 0) {
      sawSeparator = true;
      continue;
    }
    if (line.startsWith(">>>>>>> ")) {
      if (openLine > 0 && sawSeparator) {
        findings.push({ path, line: openLine, message: "complete Git conflict-marker block" });
      }
      openLine = 0;
      sawSeparator = false;
    }
  }

  return findings;
}
