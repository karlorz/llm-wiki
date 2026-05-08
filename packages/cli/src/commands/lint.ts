import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { readFile, writeFile } from "node:fs/promises";
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
  fix?: boolean;
}

interface Bucket { kind: string; items: unknown[] }
export interface LintOutput {
  vault: { path: string; source: string };
  summary: { errors: number; warnings: number; info: number };
  by_severity: { error: Bucket[]; warning: Bucket[]; info: Bucket[] };
  fixed: string[];
  unresolved: string[];
  humanHint: string;
}

const ERROR_ORDER = ["broken_wikilinks", "invalid_frontmatter", "raw_dedup", "tag_not_in_taxonomy"] as const;
const WARNING_ORDER = ["index_incomplete", "index_link_format", "stale_page", "page_too_large", "log_rotate_needed", "orphans", "legacy_citation_style", "orphaned_citations", "duplicate_frontmatter", "missing_overview"] as const;
const INFO_ORDER = ["bridges", "page_structure", "topic_map_recommended", "frontmatter_wikilink", "wikilink_citation"] as const;

export async function runLint(input: LintInput): Promise<{ exitCode: number; result: Result<LintOutput> }> {
  const buckets: Record<string, unknown[]> = {};
  const fixed: string[] = [];
  const unresolved: string[] = [];

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

    // --fix: auto-fix legacy_citation_style by moving inline ^[raw/...] to ## Sources
    if (input.fix && legacyPages.length > 0) {
      const FENCE_RE = /```[\s\S]*?```/g;
      const INLINE_MARKER = /\^\[raw\/[^\]]+\]/g;
      for (const relPath of legacyPages) {
        try {
          const absPath = `${input.vault}/${relPath}`;
          const raw = await readFile(absPath, "utf8");
          const split = splitFrontmatter(raw);
          if (!split.ok) { unresolved.push(relPath); continue; }
          const body = split.data.body;
          const rawFm = split.data.rawFrontmatter;

          // Strip fenced code blocks before scanning for inline markers
          const stripped = body.replace(FENCE_RE, "");
          const lines = stripped.split("\n");
          const inlineMarkers: string[] = [];
          let inSources = false;

          for (const line of lines) {
            if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
            if (inSources) continue;
            for (const m of line.matchAll(INLINE_MARKER)) {
              inlineMarkers.push(m[0]);
            }
          }

          if (inlineMarkers.length === 0) { unresolved.push(relPath); continue; }

          // Remove inline markers from body (only outside ## Sources)
          const bodyLines = body.split("\n");
          let inSrc = false;
          const newBodyLines: string[] = [];
          const seen = new Set<string>();

          for (const line of bodyLines) {
            if (/^## Sources\b/.test(line.trim())) { inSrc = true; newBodyLines.push(line); continue; }
            if (inSrc) { newBodyLines.push(line); continue; }

            // Check if line is a standalone marker (only a citation, no other text)
            const lineWithoutMarkers = line.replace(INLINE_MARKER, "").trim();
            if (lineWithoutMarkers.length === 0 && INLINE_MARKER.test(line)) {
              // Skip this line entirely — marker will be added to ## Sources
              continue;
            }

            // Remove citation markers trailing sentence-ending punctuation
            let cleaned = line;
            for (const marker of inlineMarkers) {
              if (seen.has(marker)) continue;
              const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              // Marker after punctuation+space or punctuation at line end
              const trailingRe = new RegExp(`([.!?]\\s*)${escapedMarker}`);
              if (trailingRe.test(cleaned)) {
                cleaned = cleaned.replace(trailingRe, "$1");
                seen.add(marker);
              }
              // Marker alone on a portion of the line (e.g. "text. ^[raw/x.md] more text")
              const midRe = new RegExp(`${escapedMarker}\\s*`);
              if (!seen.has(marker) && midRe.test(cleaned)) {
                cleaned = cleaned.replace(midRe, "");
                seen.add(marker);
              }
            }
            newBodyLines.push(cleaned);
          }

          let newBody = newBodyLines.join("\n");

          // Build or append ## Sources section
          const dedupedMarkers = [...new Set(inlineMarkers)];
          if (inSrc) {
            // Dedup against existing Sources entries before appending
            const existingSources = new Set(
              body.split("\n")
                .filter(l => /^- \^\[raw\//.test(l.trim()))
                .map(l => l.trim().replace(/^- /, ""))
            );
            const newMarkers = dedupedMarkers.filter(m => !existingSources.has(m));
            const sourceLines = newMarkers.map(m => `- ${m}`);
            if (sourceLines.length > 0) {
              newBody = newBody.trimEnd() + "\n" + sourceLines.join("\n") + "\n";
            }
          } else {
            const sourceLines = dedupedMarkers.map(m => `- ${m}`);
            // Add new Sources section
            newBody = newBody.trimEnd() + "\n\n## Sources\n\n" + sourceLines.join("\n") + "\n";
          }

          const newContent = `---\n${rawFm}\n---\n${newBody}`;
          await writeFile(absPath, newContent, "utf8");
          fixed.push(relPath);
        } catch {
          unresolved.push(relPath);
        }
      }

      // Re-scan: remove fixed pages from the bucket
      if (fixed.length > 0) {
        const fixedSet = new Set(fixed);
        const remaining = legacyPages.filter(p => !fixedSet.has(p));
        if (remaining.length > 0) buckets.legacy_citation_style = remaining;
        else delete buckets.legacy_citation_style;
      }
    }
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
      fixed: fixed,
      unresolved: unresolved,
      humanHint: hintLines.join("\n")
    })
  };
}
