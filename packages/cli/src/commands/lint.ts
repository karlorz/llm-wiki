import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { runLinks } from "./links.js";
import { runTagAudit } from "./tag-audit.js";
import { runIndexCheck } from "./index-check.js";
import { runStale } from "./stale.js";
import { runPagesize } from "./pagesize.js";
import { runLogRotate } from "./log-rotate.js";
import { runOrphans } from "./orphans.js";
import { runTopicMapCheck } from "./topic-map-check.js";
import { runIndexLinkFormat } from "./index-link-format.js";
import { runDedup } from "./dedup.js";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { isLegacyCitationStyle } from "../parsers/citations.js";

export interface LintInput {
  vault: string;
  source?: string;
  days: number;
  lines: number;
  logThreshold: number;
}

interface Bucket { kind: string; items: unknown[] }
export interface LintOutput {
  vault: { path: string; source: string };
  summary: { errors: number; warnings: number; info: number };
  by_severity: { error: Bucket[]; warning: Bucket[]; info: Bucket[] };
  humanHint: string;
}

const ERROR_ORDER = ["broken_wikilinks", "invalid_frontmatter", "raw_dedup", "tag_not_in_taxonomy"] as const;
const WARNING_ORDER = ["index_incomplete", "index_link_format", "stale_page", "page_too_large", "log_rotate_needed", "contested", "orphans", "legacy_citation_style"] as const;
const INFO_ORDER = ["bridges", "low_confidence_single_source", "topic_map_recommended"] as const;

export async function runLint(input: LintInput): Promise<{ exitCode: number; result: Result<LintOutput> }> {
  const buckets: Record<string, unknown[]> = {};

  const links = await runLinks({ vault: input.vault });
  if (links.result.ok && links.result.data.broken.length > 0) buckets.broken_wikilinks = links.result.data.broken;
  if (!links.result.ok && links.result.error === "INVALID_FRONTMATTER") {
    buckets.invalid_frontmatter = [links.result.detail ?? {}];
  }

  const tags = await runTagAudit({ vault: input.vault });
  if (tags.result.ok && tags.result.data.violations.length > 0) buckets.tag_not_in_taxonomy = tags.result.data.violations;
  if (!tags.result.ok && tags.result.error === "INVALID_FRONTMATTER") {
    buckets.invalid_frontmatter = [...(buckets.invalid_frontmatter ?? []), tags.result.detail ?? {}];
  }

  const idx = await runIndexCheck({ vault: input.vault });
  if (idx.result.ok && (idx.result.data.missing_from_index.length > 0 || idx.result.data.ghost_entries.length > 0)) {
    buckets.index_incomplete = [{
      missing_from_index: idx.result.data.missing_from_index,
      ghost_entries: idx.result.data.ghost_entries
    }];
  }

  const linkFmt = await runIndexLinkFormat({ vault: input.vault });
  if (linkFmt.result.ok && linkFmt.result.data.markdown_links.length > 0) {
    buckets.index_link_format = linkFmt.result.data.markdown_links;
  }

  const stale = await runStale({ vault: input.vault, days: input.days });
  if (stale.result.ok && stale.result.data.stale.length > 0) buckets.stale_page = stale.result.data.stale;

  const pagesize = await runPagesize({ vault: input.vault, lines: input.lines });
  if (pagesize.result.ok && pagesize.result.data.oversized.length > 0) buckets.page_too_large = pagesize.result.data.oversized;

  const rotate = await runLogRotate({ vault: input.vault, threshold: input.logThreshold, apply: false });
  if (rotate.result.ok && rotate.exitCode === ExitCode.LOG_ROTATE_NEEDED) {
    buckets.log_rotate_needed = [{ entries: rotate.result.data.entries, threshold: rotate.result.data.threshold }];
  }

  const orphans = await runOrphans({ vault: input.vault });
  if (orphans.result.ok) {
    if (orphans.result.data.orphans.length > 0) buckets.orphans = orphans.result.data.orphans;
    if (orphans.result.data.bridges.length > 0) buckets.bridges = orphans.result.data.bridges;
  }

  const topicMap = await runTopicMapCheck({ vault: input.vault });
  if (topicMap.result.ok && topicMap.result.data.recommended) {
    buckets.topic_map_recommended = [{ page_count: topicMap.result.data.page_count, threshold: topicMap.result.data.threshold }];
  }

  const dedup = await runDedup({ vault: input.vault });
  if (dedup.result.ok && dedup.result.data.duplicates.length > 0) buckets.raw_dedup = dedup.result.data.duplicates;

  // Citation style check
  const scan = await scanVault(input.vault);
  if (scan.ok) {
    const legacyPages: string[] = [];
    for (const page of scan.data.typedKnowledge) {
      const text = await readPage(page);
      const split = splitFrontmatter(text);
      if (!split.ok) continue;
      if (isLegacyCitationStyle(split.data.body)) legacyPages.push(page.relPath);
    }
    if (legacyPages.length > 0) buckets.legacy_citation_style = legacyPages;
  }

  const errorOut: Bucket[] = ERROR_ORDER.flatMap(k => buckets[k] ? [{ kind: k, items: buckets[k]! }] : []);
  const warningOut: Bucket[] = WARNING_ORDER.flatMap(k => buckets[k] ? [{ kind: k, items: buckets[k]! }] : []);
  const infoOut: Bucket[] = INFO_ORDER.flatMap(k => buckets[k] ? [{ kind: k, items: buckets[k]! }] : []);

  const summary = {
    errors: errorOut.reduce((n, b) => n + b.items.length, 0),
    warnings: warningOut.reduce((n, b) => n + b.items.length, 0),
    info: infoOut.reduce((n, b) => n + b.items.length, 0)
  };

  let exitCode: number = ExitCode.OK;
  if (summary.errors > 0) exitCode = ExitCode.LINT_HAS_ERRORS;
  else if (summary.warnings > 0 || summary.info > 0) exitCode = ExitCode.LINT_HAS_WARNINGS;

  const hintLines: string[] = [];
  if (summary.errors > 0) hintLines.push(`errors: ${summary.errors}`);
  if (summary.warnings > 0) hintLines.push(`warnings: ${summary.warnings}`);
  if (summary.info > 0) hintLines.push(`info: ${summary.info}`);
  const allBuckets = [...errorOut, ...warningOut, ...infoOut];
  for (const b of allBuckets) {
    hintLines.push(`  ${b.kind}: ${b.items.length}`);
  }
  if (hintLines.length === 0) hintLines.push("0 errors, 0 warnings, 0 info");

  return {
    exitCode,
    result: ok({
      vault: { path: input.vault, source: input.source ?? "resolved" },
      summary,
      by_severity: { error: errorOut, warning: warningOut, info: infoOut },
      humanHint: hintLines.join("\n")
    })
  };
}
