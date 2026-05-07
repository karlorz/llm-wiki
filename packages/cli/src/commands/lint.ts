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
import { isLegacyCitationStyle, hasOrphanedCitations, hasWikilinkCitations } from "../parsers/citations.js";
import { buildSlugMap } from "../utils/slug.js";

const STRUCT_MIN_BODY_LINES = 60;
const STRUCT_MIN_SECTIONS = 3;

/** Detect a second frontmatter block in the body (e.g. from a bad edit that prepended a new block). */
function hasDuplicateFrontmatter(body: string): boolean {
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
const WARNING_ORDER = ["index_incomplete", "index_link_format", "stale_page", "page_too_large", "log_rotate_needed", "orphans", "legacy_citation_style", "orphaned_citations", "duplicate_frontmatter", "missing_overview"] as const;
const INFO_ORDER = ["bridges", "page_structure", "topic_map_recommended", "frontmatter_wikilink", "wikilink_citation"] as const;

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

  // Citation style + page structure check
  const scan = await scanVault(input.vault);
  const allPages = scan.ok ? [...scan.data.typedKnowledge, ...scan.data.raw, ...scan.data.workItems, ...scan.data.compound] : [];
  const slugs = scan.ok ? buildSlugMap(allPages) : new Map<string, string>();
  if (scan.ok) {
    const legacyPages: string[] = [];
    const orphanedPages: string[] = [];
    const structFlags: string[] = [];
    const dupFrontmatter: string[] = [];
    const noOverview: string[] = [];
    const fmWikilinkFlags: string[] = [];
    const wikilinkCitationFlags: string[] = [];
    for (const page of scan.data.typedKnowledge) {
      const text = await readPage(page);
      const split = splitFrontmatter(text);
      if (!split.ok) continue;
      const body = split.data.body;
      const rawFm = split.data.rawFrontmatter;
      if (hasDuplicateFrontmatter(body)) dupFrontmatter.push(page.relPath);
      if (isLegacyCitationStyle(body)) legacyPages.push(page.relPath);
      if (hasOrphanedCitations(body)) orphanedPages.push(page.relPath);
      if (hasWikilinkCitations(body)) wikilinkCitationFlags.push(page.relPath);
      // Frontmatter wikilink resolution check
      const fmLinks = rawFm.match(/\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g) ?? [];
      for (const link of fmLinks) {
        const target = link.replace(/^\[\[/, "").replace(/(?:\|[^\[\]]*)?\]\]$/, "").trim();
        const tail = target.split("/").pop()!.replace(/\.md$/, "");
        if (!slugs.has(tail.toLowerCase())) {
          fmWikilinkFlags.push(`${page.relPath}: [[${target}]] does not resolve`);
        }
      }

      const bodyLines = body.split("\n").filter(l => l.trim().length > 0).length;
      const hasOverview = /^## Overview/m.test(body);
      if (!hasOverview) noOverview.push(page.relPath);
      if (bodyLines < STRUCT_MIN_BODY_LINES) {
        const hasRelated = /^## (Related|Relationships)/m.test(body);
        const sectionCount = (body.match(/^## /gm) ?? []).length;
        if (!hasRelated || sectionCount < STRUCT_MIN_SECTIONS) {
          const reasons: string[] = [];
          if (!hasRelated) reasons.push("no Related or Relationships");
          if (sectionCount < STRUCT_MIN_SECTIONS) reasons.push(`only ${sectionCount} sections`);
          structFlags.push(`${page.relPath}: ${bodyLines} lines, ${reasons.join(", ")}`);
        }
      }
    }
    if (legacyPages.length > 0) buckets.legacy_citation_style = legacyPages;
    if (orphanedPages.length > 0) buckets.orphaned_citations = orphanedPages;
    if (structFlags.length > 0) buckets.page_structure = structFlags;
    if (dupFrontmatter.length > 0) buckets.duplicate_frontmatter = dupFrontmatter;
    if (noOverview.length > 0) buckets.missing_overview = noOverview;
    if (fmWikilinkFlags.length > 0) buckets.frontmatter_wikilink = fmWikilinkFlags;
    if (wikilinkCitationFlags.length > 0) buckets.wikilink_citation = wikilinkCitationFlags;
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
