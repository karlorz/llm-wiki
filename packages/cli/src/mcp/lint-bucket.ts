import { runLint, type LintOutput, type LintSeverity } from "../commands/lint.js";
import { ok, ExitCode, type Result } from "@skillwiki/shared";

const ERROR_KINDS = new Set([
  "sensitive_content", "broken_wikilinks", "invalid_frontmatter", "raw_source_identity_conflict",
  "raw_dedup", "broken_sources", "tag_not_in_taxonomy", "path_too_long",
]);
const WARNING_KINDS = new Set([
  "raw_body_duplicate", "raw_subdirectory_duplicate", "file_source_url", "index_incomplete",
  "index_link_format", "stale_page", "page_too_large", "log_rotate_needed", "orphans",
  "compound_refs", "legacy_citation_style", "orphaned_citations", "duplicate_frontmatter",
  "work_item_health", "orphaned_project_pages", "missing_overview", "missing_diagram",
]);

function bucketSeverity(kind: string): LintSeverity {
  if (ERROR_KINDS.has(kind)) return "error";
  if (WARNING_KINDS.has(kind)) return "warning";
  return "info";
}

function collectBuckets(output: LintOutput) {
  return [...output.by_severity.error, ...output.by_severity.warning, ...output.by_severity.info];
}

export interface LintBucketPageInput {
  vault: string;
  source?: string;
  bucket: string;
  offset?: number;
  limit?: number;
  days?: number;
  lines?: number;
  logThreshold?: number;
}

export interface LintBucketPageOutput {
  kind: string;
  severity: LintSeverity;
  total: number;
  offset: number;
  limit: number;
  items: unknown[];
  truncated: boolean;
}

export async function fetchLintBucketPage(
  input: LintBucketPageInput,
): Promise<{ exitCode: number; result: Result<LintBucketPageOutput> }> {
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 20), 100);

  const r = await runLint({
    vault: input.vault,
    source: input.source,
    days: input.days ?? 90,
    lines: input.lines ?? 200,
    logThreshold: input.logThreshold ?? 500,
    fix: false,
    only: input.bucket,
    summary: false,
  });

  if (!r.result.ok) return { exitCode: r.exitCode, result: r.result };

  const buckets = collectBuckets(r.result.data);
  const match = buckets.find((b) => b.kind === input.bucket);
  const allItems = match?.items ?? [];
  const page = allItems.slice(offset, offset + limit);

  return {
    exitCode: ExitCode.OK,
    result: ok({
      kind: input.bucket,
      severity: bucketSeverity(input.bucket),
      total: allItems.length,
      offset,
      limit,
      items: page,
      truncated: offset + page.length < allItems.length,
    }),
  };
}