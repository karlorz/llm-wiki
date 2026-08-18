import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runLinks } from "../commands/links.js";
import { runTagAudit } from "../commands/tag-audit.js";
import { runIndexCheck } from "../commands/index-check.js";
import { runIndexLinkFormat } from "../commands/index-link-format.js";
import { runStale } from "../commands/stale.js";
import { runPagesize } from "../commands/pagesize.js";
import { runLogRotate } from "../commands/log-rotate.js";
import { runOrphans } from "../commands/orphans.js";
import { runSparseCommunity } from "../commands/sparse-community.js";
import { runTopicMapCheck } from "../commands/topic-map-check.js";
import { runDedup } from "../commands/dedup.js";
import { runRawBodyDedup } from "../commands/raw-body-dedup.js";
import { validateCompoundReferences } from "../commands/audit.js";
import { fixPathTooLong, runPathTooLong } from "../commands/path-too-long.js";
import { fixFrontmatter } from "../commands/frontmatter-fix.js";
import { safeWritePage } from "../utils/safe-write.js";
import {
  mapWithConcurrency,
  readPage,
  readPageCached,
  scanVault,
  vaultIoConcurrency,
  type PageTextCache,
  type VaultPage,
  type VaultScan,
} from "../utils/vault.js";
import { splitFrontmatter, extractFrontmatter } from "../parsers/frontmatter.js";
import { extractCitationMarkers, isLegacyCitationStyle, hasOrphanedCitations, hasWikilinkCitations } from "../parsers/citations.js";
import { buildCliSurface, validateCliRefs } from "../utils/cli-surface.js";
import { parseExpiryAnnotations } from "../parsers/expiry-annotations.js";
import { assessSourceIdentity } from "../utils/source-identity.js";
import { normalizeRawSourceTarget, rawSourceTargetExistsSync } from "../utils/raw-source.js";
import { redactSensitiveContent, scanSensitiveContent } from "../utils/sensitive-content.js";
import type {
  Bucket,
  FileSourceUrlFindings,
  LintInput,
  LintOutput,
  LintRuleContext,
  LintRuleModule,
  LintRuleResult,
  LintSummaryInput,
  LintSummaryOutput,
  RuleFixContext,
} from "./types.js";
import {
  CLI_REFS_TYPED_DIRS,
  STRUCT_MIN_BODY_LINES,
  STRUCT_MIN_SECTIONS,
  extractSourceEntries,
  hasCanonicalLocalSourceAssertion,
  hasDuplicateFrontmatter,
  lintReadVault,
  lintVaultOutput,
  readMirrorHintLines,
  severityForBucket,
  shouldCheckCanonicalLocalSourceAssertion,
  summarizeLintOutput,
  walkMarkdownFiles,
} from "./helpers.js";

// Helper for standalone single-bucket responses (used by fast paths)
function outputForOnlyBucket(
  input: LintInput | LintSummaryInput,
  match: Bucket[],
  fixed: string[],
  unresolved: string[],
  readVault = lintReadVault(input)
): { exitCode: number; result: Result<LintOutput | LintSummaryOutput> } {
  const severity = severityForBucket(input.only!);
  const filtered =
    severity === "error"
      ? { error: match, warning: [], info: [] }
      : severity === "warning"
        ? { error: [], warning: match, info: [] }
        : { error: [], warning: [], info: match };
  const summary = {
    errors: filtered.error.reduce((n, b) => n + b.items.length, 0),
    warnings: filtered.warning.reduce((n, b) => n + b.items.length, 0),
    info: filtered.info.reduce((n, b) => n + b.items.length, 0),
  };
  let exitCode: number = ExitCode.OK;
  if (summary.errors > 0) exitCode = ExitCode.LINT_HAS_ERRORS;
  else if (summary.warnings > 0 || summary.info > 0) exitCode = ExitCode.LINT_HAS_WARNINGS;
  const vault = lintVaultOutput(input, readVault);
  const hintLines = [
    ...readMirrorHintLines(vault),
    `--only ${input.only}`,
    match.length === 0 ? "0 violations" : match.map((b) => `  ${b.kind}: ${b.items.length}`).join("\n"),
  ];
  const output: LintOutput = {
    vault,
    summary,
    by_severity: filtered,
    fixed,
    unresolved,
    humanHint: hintLines.join("\n"),
  };
  return {
    exitCode,
    result: ok(input.summary ? summarizeLintOutput(output, input.examplesLimit) : output),
  };
}

async function collectCliRefsPages(vault: string): Promise<Result<VaultPage[]>> {
  if (!existsSync(join(vault, "SCHEMA.md"))) {
    return err("VAULT_PATH_INVALID", { root: vault, reason: "SCHEMA.md missing" });
  }

  const pages: VaultPage[] = [];
  for (const dir of CLI_REFS_TYPED_DIRS) {
    const absDir = join(vault, dir);
    if (!existsSync(absDir)) continue;
    pages.push(...(await walkMarkdownFiles(absDir, vault)));
  }
  return ok(pages);
}

export async function collectFileSourceUrlFindings(
  scan: VaultScan,
  pageTextCache: PageTextCache,
  options: { includeRawIdentityConflicts: boolean }
): Promise<FileSourceUrlFindings> {
  const fileSourceUrlFlags = new Set<string>();
  const fileSourceUrlFrontmatterFlags = new Set<string>();
  const rawIdentityConflicts: unknown[] = [];
  const rawPageBodyByPath = new Map<string, string>();

  const rawResults = await mapWithConcurrency(scan.raw, vaultIoConcurrency(), async (raw) => {
    const flags: string[] = [];
    const frontmatterFlags: string[] = [];
    const conflicts: unknown[] = [];
    let body: string | undefined;
    try {
      const text = await readPageCached(raw, pageTextCache);
      const split = splitFrontmatter(text);
      if (!split.ok) return { relPath: raw.relPath, body, flags, frontmatterFlags, conflicts };
      body = split.data.body;
      if (/^source_url:\s*file:\/\//m.test(split.data.rawFrontmatter)) {
        flags.push(raw.relPath);
        frontmatterFlags.push(raw.relPath);
      }
      if (options.includeRawIdentityConflicts) {
        const sourceUrl =
          split.data.rawFrontmatter.match(/^source_url:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
        const assessment = assessSourceIdentity({
          rawPath: raw.relPath,
          sourceUrl,
          body: split.data.body,
        });
        if (assessment.status === "conflict") {
          conflicts.push({
            file: raw.relPath,
            status: assessment.status,
            reasons: assessment.reasons,
            pathSignals: assessment.pathSignals,
            sourceSignals: assessment.sourceSignals,
            bodySignals: assessment.bodySignals,
          });
        }
      }
    } catch {
      // Other filesystem checks surface unreadable paths.
    }
    return { relPath: raw.relPath, body, flags, frontmatterFlags, conflicts };
  });

  for (const result of rawResults) {
    if (result.body !== undefined) rawPageBodyByPath.set(result.relPath, result.body);
    for (const flag of result.flags) fileSourceUrlFlags.add(flag);
    for (const flag of result.frontmatterFlags) fileSourceUrlFrontmatterFlags.add(flag);
    rawIdentityConflicts.push(...result.conflicts);
  }

  const canonicalSourcePages = [
    ...scan.raw,
    ...scan.typedKnowledge,
    ...scan.compound,
    ...scan.workItems,
  ].filter(shouldCheckCanonicalLocalSourceAssertion);
  const canonicalFlags = await mapWithConcurrency(canonicalSourcePages, vaultIoConcurrency(), async (page) => {
    try {
      let body = rawPageBodyByPath.get(page.relPath);
      if (body === undefined) {
        const text = await readPageCached(page, pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return null;
        body = split.data.body;
      }
      return hasCanonicalLocalSourceAssertion(body) ? page.relPath : null;
    } catch {
      return null;
    }
  });
  for (const flag of canonicalFlags) {
    if (flag) fileSourceUrlFlags.add(flag);
  }

  return { fileSourceUrlFlags, fileSourceUrlFrontmatterFlags, rawIdentityConflicts };
}

export async function applyFileSourceUrlFix(
  input: LintInput | LintSummaryInput,
  scan: VaultScan,
  fileSourceUrlFlags: Set<string>,
  fileSourceUrlFrontmatterFlags: Set<string>,
  fixed: string[],
  unresolved: string[]
): Promise<Set<string>> {
  if (!input.fix || fileSourceUrlFrontmatterFlags.size === 0) return fileSourceUrlFlags;

  const fileFixed: string[] = [];
  for (const relPath of fileSourceUrlFrontmatterFlags) {
    if (relPath.startsWith("raw/")) {
      unresolved.push(relPath);
      continue;
    }
    try {
      const absPath = `${input.vault}/${relPath}`;
      const raw = await readFile(absPath, "utf8");
      const parts = raw.split("---", 3);
      if (parts.length < 3) {
        unresolved.push(relPath);
        continue;
      }
      const rawFm = parts[1]!;
      const rest = parts[2]!;

      const sourceMatch = rest.match(/^source:\s*"?(https?:\/\/[^\s\n"]+)"?\s*$/m);
      if (!sourceMatch) {
        unresolved.push(relPath);
        continue;
      }
      const realUrl = sourceMatch[1]!;

      const newRawFm = rawFm.replace(/^source_url:\s*file:\/\/[^\n]+/m, `source_url: ${realUrl}`);
      const newContent = `---${newRawFm}---${rest}`;
      const w = await safeWritePage(absPath, newContent);
      if (!w.ok) {
        unresolved.push(relPath);
        continue;
      }
      fileFixed.push(relPath);
    } catch {
      unresolved.push(relPath);
    }
  }

  fixed.push(...fileFixed);

  if (fileFixed.length === 0) return fileSourceUrlFlags;

  const remaining = new Set(fileSourceUrlFlags);
  for (const relPath of fileFixed) {
    try {
      const page = scan.allMarkdown.find((p) => p.relPath === relPath);
      if (!page) {
        remaining.delete(relPath);
        continue;
      }
      const text = await readPage(page);
      const split = splitFrontmatter(text);
      if (!split.ok) continue;
      const stillHasFileSourceUrl = /^source_url:\s*file:\/\//m.test(split.data.rawFrontmatter);
      const stillHasCanonicalBodyAssertion =
        shouldCheckCanonicalLocalSourceAssertion(page) && hasCanonicalLocalSourceAssertion(split.data.body);
      if (!stillHasFileSourceUrl && !stillHasCanonicalBodyAssertion) {
        remaining.delete(relPath);
      }
    } catch {
      // Keep unreadable paths in the bucket rather than under-reporting.
    }
  }
  return remaining;
}

// 1. Broken Wikilinks rule
export const brokenWikilinksRule: LintRuleModule = {
  id: "broken_wikilinks",
  severity: "error",
  producedBuckets: ["broken_wikilinks", "invalid_frontmatter"],
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const links = await runLinks({ vault: ctx.vault, scan: ctx.scan, pageTextCache: ctx.pageTextCache });
    if (links.result.ok && links.result.data.broken.length > 0) {
      buckets.broken_wikilinks = links.result.data.broken;
    }
    if (!links.result.ok && links.result.error === "INVALID_FRONTMATTER") {
      buckets.invalid_frontmatter = [links.result.detail ?? {}];
    }
    return { buckets };
  },
};

// 2. Tag Not In Taxonomy rule
export const tagNotInTaxonomyRule: LintRuleModule = {
  id: "tag_not_in_taxonomy",
  severity: "error",
  producedBuckets: ["tag_not_in_taxonomy", "invalid_frontmatter"],
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const tags = await runTagAudit({ vault: ctx.vault, scan: ctx.scan, pageTextCache: ctx.pageTextCache });
    if (tags.result.ok && tags.result.data.violations.length > 0) {
      buckets.tag_not_in_taxonomy = tags.result.data.violations;
    }
    if (!tags.result.ok && tags.result.error === "INVALID_FRONTMATTER") {
      buckets.invalid_frontmatter = [tags.result.detail ?? {}];
    }
    return { buckets };
  },
};

// 3. Index Incomplete rule
export const indexIncompleteRule: LintRuleModule = {
  id: "index_incomplete",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const idx = await runIndexCheck({ vault: ctx.vault, scan: ctx.scan });
    if (idx.result.ok && (idx.result.data.missing_from_index.length > 0 || idx.result.data.ghost_entries.length > 0)) {
      buckets.index_incomplete = [
        {
          missing_from_index: idx.result.data.missing_from_index,
          ghost_entries: idx.result.data.ghost_entries,
        },
      ];
    }
    return { buckets };
  },
};

// 4. Index Link Format rule
export const indexLinkFormatRule: LintRuleModule = {
  id: "index_link_format",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const linkFmt = await runIndexLinkFormat({ vault: ctx.vault });
    if (linkFmt.result.ok && linkFmt.result.data.markdown_links.length > 0) {
      buckets.index_link_format = linkFmt.result.data.markdown_links;
    }
    return { buckets };
  },
};

// 5. Stale Page rule
export const stalePageRule: LintRuleModule = {
  id: "stale_page",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const staleResult = await runStale({
      vault: ctx.vault,
      days: ctx.days,
      scan: ctx.scan,
      pageTextCache: ctx.pageTextCache,
    });
    if (staleResult.result.ok) {
      const st = staleResult.result.data;
      const staleList = [
        ...st.stale_transcripts.map((t) => t.path),
        ...(st.unclaimed_transcripts ?? []).map((t) => t.path),
        ...st.incomplete_work_items.map((w) => w.path),
        ...(st.done_work_items ?? []).map((w) => w.path),
      ];
      if (staleList.length > 0) buckets.stale_page = staleList;
    }
    return { buckets };
  },
};

// 6. Page Too Large rule
export const pageTooLargeRule: LintRuleModule = {
  id: "page_too_large",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const pagesize = await runPagesize({
      vault: ctx.vault,
      lines: ctx.lines,
      scan: ctx.scan,
      pageTextCache: ctx.pageTextCache,
    });
    if (pagesize.result.ok && pagesize.result.data.oversized.length > 0) {
      buckets.page_too_large = pagesize.result.data.oversized;
    }
    return { buckets };
  },
};

// 7. Log Rotate Needed rule
export const logRotateNeededRule: LintRuleModule = {
  id: "log_rotate_needed",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const rotate = await runLogRotate({ vault: ctx.vault, threshold: ctx.logThreshold, apply: false });
    if (rotate.result.ok && rotate.exitCode === ExitCode.LOG_ROTATE_NEEDED) {
      buckets.log_rotate_needed = [{ entries: rotate.result.data.entries, threshold: rotate.result.data.threshold }];
    }
    return { buckets };
  },
};

// 8. Orphans & Bridges rule
export const orphansRule: LintRuleModule = {
  id: "orphans",
  severity: "warning",
  producedBuckets: ["orphans", "bridges"],
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const orphans = await runOrphans({ vault: ctx.vault, scan: ctx.scan, pageTextCache: ctx.pageTextCache });
    if (orphans.result.ok) {
      if (orphans.result.data.orphans.length > 0) buckets.orphans = orphans.result.data.orphans;
      if (orphans.result.data.bridges.length > 0) buckets.bridges = orphans.result.data.bridges;
    }
    return { buckets };
  },
};

export const bridgesRule: LintRuleModule = {
  id: "bridges",
  severity: "info",
  producedBuckets: ["bridges", "orphans"],
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    return orphansRule.run(ctx);
  },
};

// 9. Sparse Community rule
export const sparseCommunityRule: LintRuleModule = {
  id: "sparse_community",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const sparse = await runSparseCommunity({ vault: ctx.vault, scan: ctx.scan, pageTextCache: ctx.pageTextCache });
    if (sparse.result.ok && sparse.result.data.communities.length > 0) {
      buckets.sparse_community = sparse.result.data.communities;
    }
    return { buckets };
  },
};

// 10. Topic Map Recommended rule
export const topicMapRecommendedRule: LintRuleModule = {
  id: "topic_map_recommended",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const topicMap = await runTopicMapCheck({ vault: ctx.vault, scan: ctx.scan });
    if (topicMap.result.ok && topicMap.result.data.recommended) {
      buckets.topic_map_recommended = [
        { page_count: topicMap.result.data.page_count, threshold: topicMap.result.data.threshold },
      ];
    }
    return { buckets };
  },
};

// 11. Raw Dedup rule
export const rawDedupRule: LintRuleModule = {
  id: "raw_dedup",
  severity: "error",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const dedup = await runDedup({ vault: ctx.vault, scan: ctx.scan, pageTextCache: ctx.pageTextCache });
    if (dedup.result.ok && dedup.result.data.duplicates.length > 0) {
      buckets.raw_dedup = dedup.result.data.duplicates;
    }
    return { buckets };
  },
};

// 12. Raw Body Duplicate rule
export const rawBodyDuplicateRule: LintRuleModule = {
  id: "raw_body_duplicate",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const bodyDedup = await runRawBodyDedup(ctx.vault, ctx.scan, ctx.pageTextCache);
    if (bodyDedup.result.ok && bodyDedup.result.data.duplicates.length > 0) {
      buckets.raw_body_duplicate = bodyDedup.result.data.duplicates.map((d) => ({
        body_hash: d.bodyHash.slice(0, 12),
        files: d.files.map((f) => `${f.relPath} (sha256: ${f.sha256 ?? "none"})`),
      }));
    }
    return { buckets };
  },
};

// 13. Compound References rule
export const compoundRefsRule: LintRuleModule = {
  id: "compound_refs",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const compoundRefs = await validateCompoundReferences(ctx.vault, ctx.scan, ctx.pageTextCache);
    if (compoundRefs.ok && compoundRefs.data.length > 0) {
      buckets.compound_refs = compoundRefs.data;
    }
    return { buckets };
  },
};

// 14. Path Too Long rule
export const pathTooLongRule: LintRuleModule = {
  id: "path_too_long",
  severity: "error",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const buckets: Record<string, unknown[]> = {};
    const pathCheck = await runPathTooLong({ vault: ctx.vault, scan: ctx.scan });
    if (pathCheck.result.ok && pathCheck.result.data.violations.length > 0) {
      buckets.path_too_long = pathCheck.result.data.violations;
    }
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const pathViolations = currentBucketItems as Array<{ relPath: string; length: number }>;
    if (!pathViolations || pathViolations.length === 0) return currentBucketItems;

    const pathFix = await fixPathTooLong({ vault: ctx.input.vault });
    const pathFixed = pathFix.result.ok ? pathFix.result.data.fixed.map((f) => f.from) : [];
    if (pathFix.result.ok) ctx.unresolved.push(...pathFix.result.data.unresolved);
    else ctx.unresolved.push(...pathViolations.map((v) => v.relPath));

    ctx.fixed.push(...pathFixed);

    let remaining = pathViolations;
    if (pathFixed.length > 0) {
      const fixedSet = new Set(pathFixed);
      remaining = pathViolations.filter((v) => !fixedSet.has(v.relPath));
    }

    if (remaining && remaining.length > 0) {
      const rawRemaining = remaining.filter((v) => v.relPath.startsWith("raw/"));
      if (rawRemaining.length > 0) {
        ctx.unresolved.push(...rawRemaining.map((v) => v.relPath));
        const nonRaw = remaining.filter((v) => !v.relPath.startsWith("raw/"));
        return nonRaw.length > 0 ? nonRaw : undefined;
      }
      return remaining;
    }
    return undefined;
  },
};

// 15. CLI Refs rule (with fast path)
export const cliRefsRule: LintRuleModule = {
  id: "cli_refs",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const cliRefFlags: string[] = [];
    const allScanPages = [...ctx.scan.typedKnowledge];
    const cliRefResults = await mapWithConcurrency(allScanPages, vaultIoConcurrency(), async (page) => {
      const flags: string[] = [];
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const violations = validateCliRefs(text, page.relPath, ctx.cliSurface);
        for (const v of violations) {
          flags.push(`${v.page}: ${v.ref} (${v.reason})`);
        }
      } catch {
        // Skip unreadable pages.
      }
      return flags;
    });
    cliRefFlags.push(...cliRefResults.flat());
    const buckets: Record<string, unknown[]> = {};
    if (cliRefFlags.length > 0) buckets.cli_refs = cliRefFlags;
    return { buckets };
  },
  async runFastPath(input: LintInput | LintSummaryInput) {
    const readVault = lintReadVault(input);
    const lintVault = readVault.readPath;
    const pages = await collectCliRefsPages(lintVault);
    if (!pages.ok) {
      return { exitCode: ExitCode.VAULT_PATH_INVALID, result: pages };
    }

    const cliRefFlags: string[] = [];
    const cliSurface = buildCliSurface();
    for (const page of pages.data) {
      const text = await readPageCached(page);
      const violations = validateCliRefs(text, page.relPath, cliSurface);
      for (const v of violations) {
        cliRefFlags.push(`${v.page}: ${v.ref} (${v.reason})`);
      }
    }

    const infoOut: Bucket[] = cliRefFlags.length > 0 ? [{ kind: "cli_refs", items: cliRefFlags }] : [];
    const summary = { errors: 0, warnings: 0, info: cliRefFlags.length };
    const exitCode = cliRefFlags.length > 0 ? ExitCode.LINT_HAS_WARNINGS : ExitCode.OK;
    const vault = lintVaultOutput(input, readVault);
    const hintLines = [
      ...readMirrorHintLines(vault),
      `--only cli_refs`,
      cliRefFlags.length === 0 ? "0 violations" : `  cli_refs: ${cliRefFlags.length}`,
    ];
    const output: LintOutput = {
      vault,
      summary,
      by_severity: { error: [], warning: [], info: infoOut },
      fixed: [],
      unresolved: [],
      humanHint: hintLines.join("\n"),
    };

    return {
      exitCode,
      result: ok(input.summary ? summarizeLintOutput(output, input.examplesLimit) : output),
    };
  },
};

// 16. File Source URL rule (with fast path)
export const fileSourceUrlRule: LintRuleModule = {
  id: "file_source_url",
  severity: "warning",
  producedBuckets: ["file_source_url", "raw_source_identity_conflict"],
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    if (!ctx.parsedPagesCache) ctx.parsedPagesCache = {};
    if (!ctx.parsedPagesCache.fileSourceUrlFindings) {
      ctx.parsedPagesCache.fileSourceUrlFindings = await collectFileSourceUrlFindings(ctx.scan, ctx.pageTextCache, {
        includeRawIdentityConflicts: true,
      });
    }
    const findings = ctx.parsedPagesCache.fileSourceUrlFindings;
    const buckets: Record<string, unknown[]> = {};
    if (findings.fileSourceUrlFlags.size > 0) {
      buckets.file_source_url = [...findings.fileSourceUrlFlags];
    }
    if (findings.rawIdentityConflicts.length > 0) {
      buckets.raw_source_identity_conflict = findings.rawIdentityConflicts;
    }
    return { buckets };
  },
  async runFastPath(input: LintInput | LintSummaryInput) {
    const readVault = lintReadVault(input);
    const lintVault = readVault.readPath;
    const scanResult = await scanVault(lintVault);
    if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };

    const pageTextCache: PageTextCache = new Map();
    const fixed: string[] = [];
    const unresolved: string[] = [];
    const findings = await collectFileSourceUrlFindings(scanResult.data, pageTextCache, {
      includeRawIdentityConflicts: false,
    });
    const remaining = await applyFileSourceUrlFix(
      input,
      scanResult.data,
      findings.fileSourceUrlFlags,
      findings.fileSourceUrlFrontmatterFlags,
      fixed,
      unresolved
    );
    const match: Bucket[] = remaining.size > 0 ? [{ kind: "file_source_url", items: [...remaining] }] : [];
    return outputForOnlyBucket(input, match, fixed, unresolved, readVault);
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const findings = ctx.pageTextCache ? await collectFileSourceUrlFindings(ctx.scan, ctx.pageTextCache, { includeRawIdentityConflicts: false }) : { fileSourceUrlFlags: new Set<string>(), fileSourceUrlFrontmatterFlags: new Set<string>(), rawIdentityConflicts: [] };
    const remaining = await applyFileSourceUrlFix(
      ctx.input,
      ctx.scan,
      findings.fileSourceUrlFlags,
      findings.fileSourceUrlFrontmatterFlags,
      ctx.fixed,
      ctx.unresolved
    );
    return remaining.size > 0 ? [...remaining] : undefined;
  },
};

export const rawSourceIdentityConflictRule: LintRuleModule = {
  id: "raw_source_identity_conflict",
  severity: "error",
  producedBuckets: ["raw_source_identity_conflict", "file_source_url"],
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    return fileSourceUrlRule.run(ctx);
  },
};

// 17. Sensitive Content rule
export const sensitiveContentRule: LintRuleModule = {
  id: "sensitive_content",
  severity: "error",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const sensitiveFlags: unknown[] = [];
    await mapWithConcurrency(ctx.scan.allMarkdown, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        sensitiveFlags.push(...scanSensitiveContent(text, { file: page.relPath }));
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (sensitiveFlags.length > 0) buckets.sensitive_content = sensitiveFlags;
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const sensitiveFixed: string[] = [];
    for (const page of ctx.scan.allMarkdown) {
      try {
        const raw = await readPage(page);
        const redacted = redactSensitiveContent(raw, { file: page.relPath });
        if (!redacted.changed) continue;
        if (page.relPath.startsWith("raw/")) {
          ctx.unresolved.push(page.relPath);
          continue;
        }
        const w = await safeWritePage(page.absPath, redacted.text, { minBodyRatio: null });
        if (!w.ok) {
          ctx.unresolved.push(page.relPath);
          continue;
        }
        sensitiveFixed.push(page.relPath);
      } catch {
        ctx.unresolved.push(page.relPath);
      }
    }
    ctx.fixed.push(...sensitiveFixed);
    const remainingSensitiveFlags: unknown[] = [];
    for (const page of ctx.scan.allMarkdown) {
      try {
        const text = await readPage(page);
        remainingSensitiveFlags.push(...scanSensitiveContent(text, { file: page.relPath }));
      } catch {
        // Leave unreadable paths in unresolved
      }
    }
    return remainingSensitiveFlags.length > 0 ? remainingSensitiveFlags : undefined;
  },
};

// 18. Conflict Markers rule
export const conflictMarkersRule: LintRuleModule = {
  id: "conflict_markers",
  severity: "error",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const conflictMarkers: Array<{ path: string; line: number; message: string }> = [];
    await mapWithConcurrency(ctx.scan.allMarkdown, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const lines = text.split(/\r?\n/);
        let inFence = false;
        let openLine = 0;
        let sawSeparator = false;
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i]!;
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
              conflictMarkers.push({ path: page.relPath, line: openLine, message: "complete Git conflict-marker block" });
            }
            openLine = 0;
            sawSeparator = false;
          }
        }
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (conflictMarkers.length > 0) buckets.conflict_markers = conflictMarkers;
    return { buckets };
  },
};

// 19. Frontmatter YAML Invalid rule
export const frontmatterYamlInvalidRule: LintRuleModule = {
  id: "frontmatter_yaml_invalid",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const fmYamlInvalid: Array<{ path: string; message: string }> = [];
    await mapWithConcurrency(ctx.scan.allMarkdown, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const fm = extractFrontmatter(text);
        if (!fm.ok && fm.error === "INVALID_FRONTMATTER") {
          const detail = fm.detail as { message?: string } | undefined;
          const message = detail?.message ?? "invalid YAML";
          fmYamlInvalid.push({ path: page.relPath, message });
        }
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (fmYamlInvalid.length > 0) buckets.frontmatter_yaml_invalid = fmYamlInvalid;
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const invalidItems = currentBucketItems as { path: string; message: string }[];
    if (!invalidItems) return currentBucketItems;
    const remaining: { path: string; message: string }[] = [];
    for (const item of invalidItems) {
      if (item.path.startsWith("raw/")) {
        ctx.unresolved.push(item.path);
        remaining.push(item);
        continue;
      }
      const page = ctx.scan.allMarkdown.find((p) => p.relPath === item.path);
      if (!page) {
        ctx.unresolved.push(item.path);
        remaining.push(item);
        continue;
      }
      try {
        const text = await readPage(page);
        const split = splitFrontmatter(text);
        if (!split.ok) {
          ctx.unresolved.push(item.path);
          remaining.push(item);
          continue;
        }
        const newFm = fixFrontmatter(split.data.rawFrontmatter);
        const newText = `---\n${newFm}\n---\n${split.data.body}`;
        const recheck = extractFrontmatter(newText);
        if (!recheck.ok) {
          ctx.unresolved.push(item.path);
          remaining.push(item);
          continue;
        }
        const w = await safeWritePage(page.absPath, newText, { minBodyRatio: null });
        if (!w.ok) {
          ctx.unresolved.push(item.path);
          remaining.push(item);
          continue;
        }
        ctx.fixed.push(item.path);
      } catch {
        ctx.unresolved.push(item.path);
        remaining.push(item);
      }
    }
    return remaining.length > 0 ? remaining : undefined;
  },
};

// 20. Raw Subdirectory Duplicate rule
export const rawSubdirectoryDuplicateRule: LintRuleModule = {
  id: "raw_subdirectory_duplicate",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const subDirDupes: string[] = [];
    const flatStems = new Map<string, string>();
    const deepFiles: { relPath: string; stem: string; parentType: string }[] = [];

    for (const raw of ctx.scan.raw) {
      const parts = raw.relPath.split("/");
      if (parts.length === 3) {
        const stem = parts[2]!.replace(/\.md$/, "");
        flatStems.set(`${parts[1]!}/${stem}`, raw.relPath);
      } else if (parts.length > 3) {
        const stem = parts[parts.length - 1]!.replace(/\.md$/, "");
        deepFiles.push({ relPath: raw.relPath, stem, parentType: parts[1]! });
      }
    }

    for (const df of deepFiles) {
      const flatPath = flatStems.get(`${df.parentType}/${df.stem}`);
      if (flatPath) {
        subDirDupes.push(`${df.relPath} -> duplicate of ${flatPath}`);
      }
    }

    const buckets: Record<string, unknown[]> = {};
    if (subDirDupes.length > 0) buckets.raw_subdirectory_duplicate = subDirDupes;
    return { buckets };
  },
};

// 21. Typed Knowledge Rules (legacy citation, orphaned citations, page structure, dup frontmatter, overview, fm wikilink, wikilink citation, broken sources, tldr, diagram)
export const legacyCitationStyleRule: LintRuleModule = {
  id: "legacy_citation_style",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const legacyPages: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return;
        if (isLegacyCitationStyle(split.data.body)) legacyPages.push(page.relPath);
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (legacyPages.length > 0) buckets.legacy_citation_style = legacyPages;
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const legacyPages = currentBucketItems as string[];
    if (!legacyPages || legacyPages.length === 0) return currentBucketItems;

    const FENCE_RE = /```[\s\S]*?```/g;
    const INLINE_MARKER = /\^\[raw\/[^\]]+\]/g;
    const fixedHere: string[] = [];

    for (const relPath of legacyPages) {
      try {
        const absPath = `${ctx.input.vault}/${relPath}`;
        const raw = await readFile(absPath, "utf8");
        const split = splitFrontmatter(raw);
        if (!split.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        const body = split.data.body;
        const rawFm = split.data.rawFrontmatter;

        const stripped = body.replace(FENCE_RE, "");
        const lines = stripped.split("\n");
        const inlineMarkers: string[] = [];
        let inSources = false;

        for (const line of lines) {
          if (/^## Sources\b/.test(line.trim())) {
            inSources = true;
            continue;
          }
          if (inSources) continue;
          for (const m of line.matchAll(INLINE_MARKER)) {
            inlineMarkers.push(m[0]);
          }
        }

        if (inlineMarkers.length === 0) {
          ctx.unresolved.push(relPath);
          continue;
        }

        const bodyLines = body.split("\n");
        let inSrc = false;
        const newBodyLines: string[] = [];

        for (const line of bodyLines) {
          if (/^## Sources\b/.test(line.trim())) {
            inSrc = true;
            newBodyLines.push(line);
            continue;
          }
          if (inSrc) {
            newBodyLines.push(line);
            continue;
          }

          INLINE_MARKER.lastIndex = 0;
          const lineWithoutMarkers = line.replace(INLINE_MARKER, "").trim();
          INLINE_MARKER.lastIndex = 0;
          if (lineWithoutMarkers.length === 0 && INLINE_MARKER.test(line)) {
            continue;
          }

          let cleaned = line;
          for (const marker of inlineMarkers) {
            const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const trailingRe = new RegExp(`([.!?]\\s*)${escapedMarker}`);
            if (trailingRe.test(cleaned)) {
              cleaned = cleaned.replace(trailingRe, "$1");
            }
            const midRe = new RegExp(`${escapedMarker}\\s*`);
            if (midRe.test(cleaned)) {
              cleaned = cleaned.replace(midRe, "");
            }
          }
          newBodyLines.push(cleaned);
        }

        let newBody = newBodyLines.join("\n");
        const dedupedMarkers = [...new Set(inlineMarkers)];
        if (inSrc) {
          const existingSources = new Set(
            body
              .split("\n")
              .filter((l) => /^- \^\[raw\//.test(l.trim()))
              .map((l) => l.trim().replace(/^- /, ""))
          );
          const newMarkers = dedupedMarkers.filter((m) => !existingSources.has(m));
          const sourceLines = newMarkers.map((m) => `- ${m}`);
          if (sourceLines.length > 0) {
            newBody = newBody.trimEnd() + "\n" + sourceLines.join("\n") + "\n";
          }
        } else {
          const sourceLines = dedupedMarkers.map((m) => `- ${m}`);
          newBody = newBody.trimEnd() + "\n\n## Sources\n\n" + sourceLines.join("\n") + "\n";
        }

        const newContent = `---\n${rawFm}\n---\n${newBody}`;
        const w = await safeWritePage(absPath, newContent);
        if (!w.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        fixedHere.push(relPath);
      } catch {
        ctx.unresolved.push(relPath);
      }
    }

    ctx.fixed.push(...fixedHere);
    if (fixedHere.length > 0) {
      const fixedSet = new Set(fixedHere);
      const remaining = legacyPages.filter((p) => !fixedSet.has(p));
      return remaining.length > 0 ? remaining : undefined;
    }
    return currentBucketItems;
  },
};

export const orphanedCitationsRule: LintRuleModule = {
  id: "orphaned_citations",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const orphanedPages: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (split.ok && hasOrphanedCitations(split.data.body)) orphanedPages.push(page.relPath);
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (orphanedPages.length > 0) buckets.orphaned_citations = orphanedPages;
    return { buckets };
  },
};

export const pageStructureRule: LintRuleModule = {
  id: "page_structure",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const structFlags: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return;
        const body = split.data.body;
        const bodyLines = body.split("\n").filter((l) => l.trim().length > 0).length;
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
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (structFlags.length > 0) buckets.page_structure = structFlags;
    return { buckets };
  },
};

export const duplicateFrontmatterRule: LintRuleModule = {
  id: "duplicate_frontmatter",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const dupFrontmatter: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (split.ok && hasDuplicateFrontmatter(split.data.body)) dupFrontmatter.push(page.relPath);
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (dupFrontmatter.length > 0) buckets.duplicate_frontmatter = dupFrontmatter;
    return { buckets };
  },
};

export const missingOverviewRule: LintRuleModule = {
  id: "missing_overview",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const noOverview: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return;
        if (!/^## Overview/m.test(split.data.body)) noOverview.push(page.relPath);
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (noOverview.length > 0) buckets.missing_overview = noOverview;
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const noOverview = currentBucketItems as string[];
    if (!noOverview || noOverview.length === 0) return currentBucketItems;
    const fixedHere: string[] = [];

    for (const relPath of noOverview) {
      try {
        const absPath = `${ctx.input.vault}/${relPath}`;
        const raw = await readFile(absPath, "utf8");
        const split = splitFrontmatter(raw);
        if (!split.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        const body = split.data.body;
        const rawFm = split.data.rawFrontmatter;

        const fm = extractFrontmatter(raw);
        const title = fm.ok && typeof fm.data.title === "string" ? fm.data.title : "";

        const overviewSection = `## Overview\n\n${title}`;
        const trimmedBody = body.replace(/^\n+/, "");
        const newContent = `---\n${rawFm}\n---\n\n${overviewSection}\n\n${trimmedBody}`;
        const w = await safeWritePage(absPath, newContent);
        if (!w.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        fixedHere.push(relPath);
      } catch {
        ctx.unresolved.push(relPath);
      }
    }

    ctx.fixed.push(...fixedHere);
    if (fixedHere.length > 0) {
      const fixedSet = new Set(fixedHere);
      const remaining = noOverview.filter((p) => !fixedSet.has(p));
      return remaining.length > 0 ? remaining : undefined;
    }
    return currentBucketItems;
  },
};

export const frontmatterWikilinkRule: LintRuleModule = {
  id: "frontmatter_wikilink",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const fmWikilinkFlags: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return;
        const rawFm = split.data.rawFrontmatter;
        const fmLinks = rawFm.match(/\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g) ?? [];
        for (const link of fmLinks) {
          const target = link.replace(/^\[\[/, "").replace(/(?:\|[^\[\]]*)?\]\]$/, "").trim();
          if (!ctx.wikilinkResolver.resolve(target).path) {
            fmWikilinkFlags.push(`${page.relPath}: [[${target}]] does not resolve`);
          }
        }
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (fmWikilinkFlags.length > 0) buckets.frontmatter_wikilink = fmWikilinkFlags;
    return { buckets };
  },
};

export const wikilinkCitationRule: LintRuleModule = {
  id: "wikilink_citation",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const wikilinkCitationFlags: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (split.ok && hasWikilinkCitations(split.data.body)) wikilinkCitationFlags.push(page.relPath);
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (wikilinkCitationFlags.length > 0) buckets.wikilink_citation = wikilinkCitationFlags;
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const wikilinkCitationFlags = currentBucketItems as string[];
    if (!wikilinkCitationFlags || wikilinkCitationFlags.length === 0) return currentBucketItems;

    const WIKILINK_RE = /\[\[raw\/([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    const FENCE_RE = /```[\s\S]*?```/g;
    const wikilinkFixed: string[] = [];

    for (const relPath of wikilinkCitationFlags) {
      try {
        const absPath = `${ctx.input.vault}/${relPath}`;
        const raw = await readFile(absPath, "utf8");
        const split = splitFrontmatter(raw);
        if (!split.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        const body = split.data.body;
        const rawFm = split.data.rawFrontmatter;

        const stripped = body.replace(FENCE_RE, "");
        const wikilinkMatches = [...stripped.matchAll(WIKILINK_RE)];
        if (wikilinkMatches.length === 0) {
          ctx.unresolved.push(relPath);
          continue;
        }

        const wikilinkPaths = [...new Set(wikilinkMatches.map((m) => m[1]!))];
        const bodyLines = body.split("\n");
        let inSrc = false;
        const newBodyLines: string[] = [];
        for (const line of bodyLines) {
          if (/^## Sources\b/.test(line.trim())) {
            inSrc = true;
            newBodyLines.push(line);
            continue;
          }
          if (inSrc) {
            newBodyLines.push(line);
            continue;
          }
          let cleaned = line.replace(/\[\[raw\/[^\]|]+(?:\|[^\]]*)?\]\]/g, "");
          cleaned = cleaned.replace(/\s+\./g, ".").replace(/\s{2,}/g, " ").replace(/\s+$/, "");
          if (cleaned.length > 0 || line.trim().length === 0) {
            newBodyLines.push(cleaned);
          }
        }

        let newBody = newBodyLines.join("\n");
        const citationMarkers = wikilinkPaths.map((p) => `^[raw/${p}]`);
        const sourceEntries = extractSourceEntries(rawFm);
        const fmMarkers: string[] = [];
        for (const entry of sourceEntries) {
          let rawPath = entry.replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, "");
          rawPath = rawPath.replace(/^\^\[/, "").replace(/\]$/, "");
          if (rawPath.startsWith("raw/")) {
            fmMarkers.push(`^[${rawPath}]`);
          }
        }
        const allMarkers = [...new Set([...citationMarkers, ...fmMarkers])];

        const hasSourcesSection = /^## Sources\b/m.test(newBody);
        if (hasSourcesSection) {
          const existingSources = new Set(
            newBody
              .split("\n")
              .filter((l) => /^- \^\[raw\//.test(l.trim()))
              .map((l) => l.trim().replace(/^- /, ""))
          );
          const newMarkers = allMarkers.filter((m) => !existingSources.has(m));
          const sourceLines = newMarkers.map((m) => `- ${m}`);
          if (sourceLines.length > 0) {
            newBody = newBody.trimEnd() + "\n" + sourceLines.join("\n") + "\n";
          }
        } else {
          const sourceLines = allMarkers.map((m) => `- ${m}`);
          newBody = newBody.trimEnd() + "\n\n## Sources\n\n" + sourceLines.join("\n") + "\n";
        }

        const newContent = `---\n${rawFm}\n---\n${newBody}`;
        const w = await safeWritePage(absPath, newContent);
        if (!w.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        wikilinkFixed.push(relPath);
      } catch {
        ctx.unresolved.push(relPath);
      }
    }

    ctx.fixed.push(...wikilinkFixed);
    if (wikilinkFixed.length > 0) {
      const fixedSet = new Set(wikilinkFixed);
      const remaining = wikilinkCitationFlags.filter((p) => !fixedSet.has(p));
      return remaining.length > 0 ? remaining : undefined;
    }
    return currentBucketItems;
  },
};

export const brokenSourcesRule: LintRuleModule = {
  id: "broken_sources",
  severity: "error",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const brokenSourceFlags = new Set<string>();
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return;
        const body = split.data.body;
        const rawFm = split.data.rawFrontmatter;
        const sourcesEntries = extractSourceEntries(rawFm);
        for (const entry of sourcesEntries) {
          const rawPath = normalizeRawSourceTarget(entry);
          if (!rawPath) continue;
          if (!rawSourceTargetExistsSync(ctx.vault, rawPath)) {
            brokenSourceFlags.add(`${page.relPath}: ${rawPath}`);
          }
        }
        for (const marker of extractCitationMarkers(body)) {
          if (!rawSourceTargetExistsSync(ctx.vault, marker.target)) {
            brokenSourceFlags.add(`${page.relPath}: ${marker.target}`);
          }
        }
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (brokenSourceFlags.size > 0) buckets.broken_sources = [...brokenSourceFlags];
    return { buckets };
  },
};

export const missingTldrRule: LintRuleModule = {
  id: "missing_tldr",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const missingTldrFlags: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const split = splitFrontmatter(text);
        if (!split.ok) return;
        const body = split.data.body;
        const bodyFirst15 = body.split("\n").slice(0, 15).join("\n");
        if (!/^>\s*\*\*TL;DR:?\*\*/m.test(bodyFirst15) && !/^##\s+TL;\s*DR/m.test(bodyFirst15)) {
          missingTldrFlags.push(page.relPath);
        }
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (missingTldrFlags.length > 0) buckets.missing_tldr = missingTldrFlags;
    return { buckets };
  },
  async fix(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined> {
    const missingTldrFlags = currentBucketItems as string[];
    if (!missingTldrFlags || missingTldrFlags.length === 0) return currentBucketItems;
    const fixedHere: string[] = [];

    for (const relPath of missingTldrFlags) {
      try {
        const absPath = `${ctx.input.vault}/${relPath}`;
        const raw = await readFile(absPath, "utf8");
        const split = splitFrontmatter(raw);
        if (!split.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        const body = split.data.body;
        const rawFm = split.data.rawFrontmatter;

        const lines = body.split("\n");
        let insertIndex = 0;
        for (let i = 0; i < lines.length; i++) {
          if (/^# /.test(lines[i]!)) {
            insertIndex = i + 1;
            while (insertIndex < lines.length && lines[insertIndex]!.trim() === "") {
              insertIndex++;
            }
            break;
          }
        }
        if (insertIndex === 0) {
          lines.splice(0, 0, "", "> **TL;DR:** ");
        } else {
          lines.splice(insertIndex, 0, "> **TL;DR:** ");
        }
        const trimmedFm = rawFm.endsWith("\n") ? rawFm : rawFm + "\n";
        const newContent = `---\n${trimmedFm}---\n${lines.join("\n")}`;
        const w = await safeWritePage(absPath, newContent);
        if (!w.ok) {
          ctx.unresolved.push(relPath);
          continue;
        }
        fixedHere.push(relPath);
      } catch {
        ctx.unresolved.push(relPath);
      }
    }

    ctx.fixed.push(...fixedHere);
    if (fixedHere.length > 0) {
      const fixedSet = new Set(fixedHere);
      const remaining = missingTldrFlags.filter((p) => !fixedSet.has(p));
      return remaining.length > 0 ? remaining : undefined;
    }
    return currentBucketItems;
  },
};

export const missingDiagramRule: LintRuleModule = {
  id: "missing_diagram",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const missingDiagramFlags: string[] = [];
    await mapWithConcurrency(ctx.scan.typedKnowledge, vaultIoConcurrency(), async (page) => {
      try {
        const text = await readPageCached(page, ctx.pageTextCache);
        const fmData = extractFrontmatter(text);
        const pageTags: string[] = fmData.ok && Array.isArray(fmData.data.tags) ? fmData.data.tags : [];
        if (pageTags.includes("architecture") && !text.includes("```mermaid")) {
          missingDiagramFlags.push(page.relPath);
        }
      } catch {
        // Skip unreadable pages
      }
    });
    const buckets: Record<string, unknown[]> = {};
    if (missingDiagramFlags.length > 0) buckets.missing_diagram = missingDiagramFlags;
    return { buckets };
  },
};

// 22. Work Item Health rule
export const workItemHealthRule: LintRuleModule = {
  id: "work_item_health",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const workItemHealth: string[] = [];
    const workItemDirs = new Map<string, VaultPage[]>();
    for (const page of ctx.scan.workItems) {
      const dir = page.relPath.replace(/\/(spec|plan|log)\.md$/, "");
      const pages = workItemDirs.get(dir) ?? [];
      pages.push(page);
      workItemDirs.set(dir, pages);
    }
    const workItemHealthResults = await mapWithConcurrency(
      [...workItemDirs.entries()],
      vaultIoConcurrency(),
      async ([dir, pages]) => {
        const flags: string[] = [];
        const specPage = pages.find((p) => p.relPath.endsWith("/spec.md"));
        const hasPlan = pages.some((p) => p.relPath.endsWith("/plan.md"));
        let specStatus: string | undefined;
        let specStarted: unknown;
        if (specPage) {
          const text = await readPageCached(specPage, ctx.pageTextCache);
          const fm = extractFrontmatter(text);
          if (fm.ok) {
            specStatus = typeof fm.data.status === "string" ? fm.data.status : undefined;
            specStarted = fm.data.started;
          }
        }
        const isClosed = specStatus === "completed" || specStatus === "abandoned";
        if (specPage && !hasPlan && !isClosed) {
          const lastSegment = dir.split("/").pop()!;
          const dateMatch = lastSegment.match(/^(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            const dirDate = Date.parse(dateMatch[1]!);
            if (!isNaN(dirDate) && Date.now() - dirDate > 24 * 60 * 60 * 1000) {
              flags.push(`${dir}/spec.md: has spec but no plan after 24h`);
            }
          }
        }
        if (specPage && specStatus === "in-progress" && !specStarted) {
          flags.push(`${specPage.relPath}: in-progress without started date`);
        }
        return flags;
      }
    );
    workItemHealth.push(...workItemHealthResults.flat());
    const buckets: Record<string, unknown[]> = {};
    if (workItemHealth.length > 0) buckets.work_item_health = workItemHealth;
    return { buckets };
  },
};

// 23. Orphaned Project Pages rule
export const orphanedProjectPagesRule: LintRuleModule = {
  id: "orphaned_project_pages",
  severity: "warning",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const orphanedProjectPages: string[] = [];
    const knowledgeContentCache = new Map<string, Promise<string | null>>();
    const readKnowledgeContent = (slug: string): Promise<string | null> => {
      const existing = knowledgeContentCache.get(slug);
      if (existing) return existing;
      const knowledgePath = join(ctx.vault, "projects", slug, "knowledge.md");
      const pending = existsSync(knowledgePath) ? readFile(knowledgePath, "utf8").catch(() => null) : Promise.resolve(null);
      knowledgeContentCache.set(slug, pending);
      return pending;
    };
    const orphanedProjectPageResults = await mapWithConcurrency(
      ctx.scan.typedKnowledge,
      vaultIoConcurrency(),
      async (page) => {
        const flags: string[] = [];
        try {
          const text = await readPageCached(page, ctx.pageTextCache);
          const fm = extractFrontmatter(text);
          if (!fm.ok) return flags;
          const pp = fm.data.provenance_projects;
          if (!Array.isArray(pp)) return flags;
          for (const entry of pp) {
            const slugMatch = String(entry).match(/\[\[([^\]]+)\]\]/);
            if (!slugMatch) continue;
            const slug = slugMatch[1]!;
            const knowledgeContent = await readKnowledgeContent(slug);
            if (knowledgeContent === null) continue;
            const pageRef = page.relPath.replace(/\.md$/, "");
            if (!knowledgeContent.includes(`[[${pageRef}]]`)) {
              flags.push(`${page.relPath}: not in projects/${slug}/knowledge.md`);
            }
          }
        } catch {
          // Skip unreadable pages.
        }
        return flags;
      }
    );
    orphanedProjectPages.push(...orphanedProjectPageResults.flat());
    const buckets: Record<string, unknown[]> = {};
    if (orphanedProjectPages.length > 0) buckets.orphaned_project_pages = orphanedProjectPages;
    return { buckets };
  },
};

// 24. Stale Sections rule
export const staleSectionsRule: LintRuleModule = {
  id: "stale_sections",
  severity: "info",
  async run(ctx: LintRuleContext): Promise<LintRuleResult> {
    const staleSectionFlags: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const approachingThreshold = 7;
    const staleSectionResults = await mapWithConcurrency(
      ctx.scan.typedKnowledge,
      vaultIoConcurrency(),
      async (page) => {
        const flags: string[] = [];
        try {
          const text = await readPageCached(page, ctx.pageTextCache);
          const annotations = parseExpiryAnnotations(text, page.relPath);
          for (const ann of annotations) {
            if (ann.expires < today) {
              flags.push(`${page.relPath}: section "${ann.heading}" expired on ${ann.expires}`);
            } else {
              const daysUntilExpiry = Math.floor((Date.parse(ann.expires) - Date.now()) / 86400000);
              if (daysUntilExpiry <= approachingThreshold) {
                flags.push(
                  `${page.relPath}: section "${ann.heading}" expires in ${daysUntilExpiry} day(s) (${ann.expires})`
                );
              }
            }
          }
        } catch {
          // skip unreadable pages
        }
        return flags;
      }
    );
    staleSectionFlags.push(...staleSectionResults.flat());
    const buckets: Record<string, unknown[]> = {};
    if (staleSectionFlags.length > 0) buckets.stale_sections = staleSectionFlags;
    return { buckets };
  },
};

// Registered rule list in default execution order
export const LINT_RULES: readonly LintRuleModule[] = [
  brokenWikilinksRule,
  tagNotInTaxonomyRule,
  indexIncompleteRule,
  indexLinkFormatRule,
  stalePageRule,
  pageTooLargeRule,
  logRotateNeededRule,
  orphansRule,
  sparseCommunityRule,
  topicMapRecommendedRule,
  rawDedupRule,
  rawBodyDuplicateRule,
  compoundRefsRule,
  pathTooLongRule,
  sensitiveContentRule,
  conflictMarkersRule,
  frontmatterYamlInvalidRule,
  rawSubdirectoryDuplicateRule,
  fileSourceUrlRule,
  legacyCitationStyleRule,
  orphanedCitationsRule,
  pageStructureRule,
  duplicateFrontmatterRule,
  missingOverviewRule,
  frontmatterWikilinkRule,
  wikilinkCitationRule,
  brokenSourcesRule,
  missingTldrRule,
  missingDiagramRule,
  workItemHealthRule,
  orphanedProjectPagesRule,
  cliRefsRule,
  staleSectionsRule,
];
