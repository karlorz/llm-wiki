import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { extractIssuePage } from "../lint/fingerprints.js";
import { defaultLintRunner, LintRunner } from "../lint/runner.js";
import type { LintOutput, LintSeverity } from "../lint/types.js";
import { referencesFromText } from "../utils/source-reference-index.js";
import { resolveReadOnlyVaultRoot, scanVault, readPage, type VaultScan } from "../utils/vault.js";
import { resolveRuntimePath } from "../utils/wiki-path.js";

export const CITATION_COVERAGE_DEFINITION =
  "Share of typed-knowledge pages carrying at least one canonical raw source citation via frontmatter sources or ^[raw/...] body markers";

export interface EvalInput {
  vault?: string;
  baseRef?: string;
  top?: number;
  wiki?: string;
  cwd?: string;
  envValue?: string;
  home?: string;
}

export interface EvalPageFindingsSummary {
  path: string;
  findings_count: number;
  by_severity: {
    error: number;
    warning: number;
    info: number;
  };
}

export interface EvalCitationCoverage {
  total_typed_pages: number;
  pages_with_citations: number;
  ratio: number;
  definition: string;
}

export interface EvalSeveritySummary {
  error: number;
  warning: number;
  info: number;
}

export interface EvalDelta {
  base_ref: string;
  findings_total_delta: number;
  by_severity: EvalSeveritySummary;
  pages_improved: string[];
  pages_worsened: string[];
}

export interface EvalOutput {
  pages_scanned: number;
  findings_total: number;
  findings_by_severity: EvalSeveritySummary;
  citation_coverage: EvalCitationCoverage;
  worst_pages: EvalPageFindingsSummary[];
  delta?: EvalDelta;
  humanHint: string;
}

interface VaultEvalAggregation {
  pagesScanned: number;
  findingsTotal: number;
  findingsBySeverity: EvalSeveritySummary;
  citationCoverage: EvalCitationCoverage;
  pageFindingsMap: Map<string, { error: number; warning: number; info: number; total: number }>;
  worstPages: EvalPageFindingsSummary[];
}

async function computeCitationCoverage(scan: VaultScan): Promise<EvalCitationCoverage> {
  const typedPages = scan.typedKnowledge;
  const total = typedPages.length;
  if (total === 0) {
    return {
      total_typed_pages: 0,
      pages_with_citations: 0,
      ratio: 1.0,
      definition: CITATION_COVERAGE_DEFINITION,
    };
  }

  let citedCount = 0;
  for (const page of typedPages) {
    try {
      const text = await readPage(page);
      if (referencesFromText(text).length > 0) citedCount++;
    } catch {
      // Unreadable page counts as uncited
    }
  }

  const ratio = Math.round((citedCount / total) * 10000) / 10000;
  return {
    total_typed_pages: total,
    pages_with_citations: citedCount,
    ratio,
    definition: CITATION_COVERAGE_DEFINITION,
  };
}

async function aggregateVault(
  vaultPath: string,
  topLimit: number,
  runner: LintRunner = defaultLintRunner
): Promise<Result<VaultEvalAggregation>> {
  const scanResult = await scanVault(vaultPath);
  if (!scanResult.ok) {
    return scanResult;
  }
  const scan = scanResult.data;

  const lintRes = await runner.run({
    vault: vaultPath,
    days: 90,
    lines: 200,
    logThreshold: 500,
    summary: false,
  });

  if (!lintRes.result.ok) {
    return lintRes.result;
  }

  const lintOut = lintRes.result.data as LintOutput;
  const pageFindingsMap = new Map<string, { error: number; warning: number; info: number; total: number }>();

  function recordFinding(page: string, severity: LintSeverity) {
    const p = page.length > 0 ? page : "<global>";
    const entry = pageFindingsMap.get(p) ?? { error: 0, warning: 0, info: 0, total: 0 };
    entry[severity]++;
    entry.total++;
    pageFindingsMap.set(p, entry);
  }

  for (const b of lintOut.by_severity.error) {
    for (const item of b.items) {
      recordFinding(extractIssuePage(item), "error");
    }
  }
  for (const b of lintOut.by_severity.warning) {
    for (const item of b.items) {
      recordFinding(extractIssuePage(item), "warning");
    }
  }
  for (const b of lintOut.by_severity.info) {
    for (const item of b.items) {
      recordFinding(extractIssuePage(item), "info");
    }
  }

  const sortedPages: EvalPageFindingsSummary[] = [...pageFindingsMap.entries()]
    .map(([path, counts]) => ({
      path,
      findings_count: counts.total,
      by_severity: {
        error: counts.error,
        warning: counts.warning,
        info: counts.info,
      },
    }))
    .sort((a, b) => {
      if (b.findings_count !== a.findings_count) {
        return b.findings_count - a.findings_count;
      }
      return a.path.localeCompare(b.path);
    });

  const worstPages = sortedPages.slice(0, topLimit);

  const findingsBySeverity: EvalSeveritySummary = {
    error: lintOut.summary.errors,
    warning: lintOut.summary.warnings,
    info: lintOut.summary.info,
  };

  const findingsTotal =
    findingsBySeverity.error + findingsBySeverity.warning + findingsBySeverity.info;

  const citationCoverage = await computeCitationCoverage(scan);

  return ok({
    pagesScanned: scan.allMarkdown.length,
    findingsTotal,
    findingsBySeverity,
    citationCoverage,
    pageFindingsMap,
    worstPages,
  });
}

function buildHumanHint(output: EvalOutput): string {
  const lines: string[] = [];
  lines.push("=== Vault Evaluation Report ===");
  lines.push(`Pages scanned: ${output.pages_scanned}`);
  lines.push(
    `Findings: ${output.findings_total} (errors: ${output.findings_by_severity.error}, warnings: ${output.findings_by_severity.warning}, info: ${output.findings_by_severity.info})`
  );
  lines.push(
    `Citation coverage: ${(output.citation_coverage.ratio * 100).toFixed(1)}% (${output.citation_coverage.pages_with_citations}/${output.citation_coverage.total_typed_pages} typed pages)`
  );
  lines.push(`  Definition: ${output.citation_coverage.definition}`);

  if (output.delta) {
    const d = output.delta;
    lines.push(`Delta vs ${d.base_ref}:`);
    lines.push(
      `  Findings total delta: ${d.findings_total_delta >= 0 ? "+" : ""}${d.findings_total_delta} (errors: ${d.by_severity.error >= 0 ? "+" : ""}${d.by_severity.error}, warnings: ${d.by_severity.warning >= 0 ? "+" : ""}${d.by_severity.warning}, info: ${d.by_severity.info >= 0 ? "+" : ""}${d.by_severity.info})`
    );
    lines.push(`  Pages improved: ${d.pages_improved.length}`);
    lines.push(`  Pages worsened: ${d.pages_worsened.length}`);
  }

  if (output.worst_pages.length > 0) {
    lines.push(`Top worst pages (${output.worst_pages.length}):`);
    for (const page of output.worst_pages) {
      lines.push(
        `  ${page.path}: ${page.findings_count} findings (e:${page.by_severity.error}, w:${page.by_severity.warning}, i:${page.by_severity.info})`
      );
    }
  } else {
    lines.push("Top worst pages: none (clean vault)");
  }

  return lines.join("\n");
}

export async function runEval(
  input: EvalInput
): Promise<{ exitCode: number; result: Result<EvalOutput> }> {
  let vaultPath: string;
  if (input.vault) {
    vaultPath = input.vault;
  } else {
    const r = await resolveRuntimePath({
      flag: undefined,
      envValue: input.envValue,
      home: input.home ?? "",
      wiki: input.wiki,
      cwd: input.cwd,
    });
    if (!r.ok) {
      const exitCode =
        r.error === "UNKNOWN_WIKI_PROFILE"
          ? ExitCode.UNKNOWN_WIKI_PROFILE
          : ExitCode.NO_VAULT_CONFIGURED;
      return { exitCode, result: r };
    }
    vaultPath = r.data.path;
  }

  const topLimit = input.top !== undefined && input.top > 0 ? input.top : 10;

  // Resolve read-only vault (e.g. FUSE mirror)
  const { root: scanRoot } = resolveReadOnlyVaultRoot(vaultPath);

  const headAggRes = await aggregateVault(scanRoot, topLimit);
  if (!headAggRes.ok) {
    return {
      exitCode:
        headAggRes.error === "VAULT_PATH_INVALID"
          ? ExitCode.VAULT_PATH_INVALID
          : ExitCode.OK,
      result: headAggRes,
    };
  }

  const head = headAggRes.data;

  let delta: EvalDelta | undefined;

  if (input.baseRef) {
    const baseRef = input.baseRef;
    if (!existsSync(join(vaultPath, ".git"))) {
      return {
        exitCode: ExitCode.USAGE,
        result: err("NOT_A_GIT_REPO", {
          path: vaultPath,
          message: `--base requires a git repository at ${vaultPath}`,
        }),
      };
    }

    try {
      execFileSync("git", ["rev-parse", "--verify", baseRef], {
        cwd: vaultPath,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return {
        exitCode: ExitCode.USAGE,
        result: err("EVAL_DELTA_BASE_UNAVAILABLE", {
          baseRef,
          message: `base ref ${baseRef} does not resolve`,
        }),
      };
    }

    const tmpRoot = mkdtempSync(join(tmpdir(), "skillwiki-eval-delta-"));
    try {
      const archive = execFileSync("git", ["archive", "--format=tar", baseRef], {
        cwd: vaultPath,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      });
      execFileSync("tar", ["-xf", "-"], {
        cwd: tmpRoot,
        input: archive,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const baseAggRes = await aggregateVault(tmpRoot, topLimit);
      if (!baseAggRes.ok) {
        return {
          exitCode: ExitCode.USAGE,
          result: err("EVAL_DELTA_BASE_FAILED", {
            baseRef,
            detail: baseAggRes,
          }),
        };
      }

      const base = baseAggRes.data;

      // Compute pages improved and worsened
      const allPagePaths = new Set([
        ...head.pageFindingsMap.keys(),
        ...base.pageFindingsMap.keys(),
      ]);

      const pagesImproved: string[] = [];
      const pagesWorsened: string[] = [];

      for (const page of allPagePaths) {
        const headCounts = head.pageFindingsMap.get(page)?.total ?? 0;
        const baseCounts = base.pageFindingsMap.get(page)?.total ?? 0;
        if (headCounts < baseCounts) {
          pagesImproved.push(page);
        } else if (headCounts > baseCounts) {
          pagesWorsened.push(page);
        }
      }

      pagesImproved.sort();
      pagesWorsened.sort();

      delta = {
        base_ref: baseRef,
        findings_total_delta: head.findingsTotal - base.findingsTotal,
        by_severity: {
          error: head.findingsBySeverity.error - base.findingsBySeverity.error,
          warning: head.findingsBySeverity.warning - base.findingsBySeverity.warning,
          info: head.findingsBySeverity.info - base.findingsBySeverity.info,
        },
        pages_improved: pagesImproved,
        pages_worsened: pagesWorsened,
      };
    } catch (e: unknown) {
      return {
        exitCode: ExitCode.USAGE,
        result: err("EVAL_DELTA_ARCHIVE_FAILED", {
          baseRef,
          message: String(e),
        }),
      };
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  const output: EvalOutput = {
    pages_scanned: head.pagesScanned,
    findings_total: head.findingsTotal,
    findings_by_severity: head.findingsBySeverity,
    citation_coverage: head.citationCoverage,
    worst_pages: head.worstPages,
    ...(delta ? { delta } : {}),
    humanHint: "",
  };

  output.humanHint = buildHumanHint(output);

  return {
    exitCode: ExitCode.OK,
    result: ok(output),
  };
}
