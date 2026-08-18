import { ok, err, ExitCode, type ExitCodeValue, type Result } from "@skillwiki/shared";
import {
  mapWithConcurrency,
  readPageCached,
  scanVault,
  vaultIoConcurrency,
  type PageTextCache,
} from "../utils/vault.js";
import { buildWikilinkResolver } from "../utils/wikilink-resolver.js";
import { buildCliSurface } from "../utils/cli-surface.js";
import type {
  Bucket,
  LintInput,
  LintOutput,
  LintRuleContext,
  LintRuleModule,
  LintSummaryInput,
  LintSummaryOutput,
  RuleFixContext,
  SyncLintDeltaInput,
  SyncLintDeltaOutput,
} from "./types.js";
import {
  ERROR_ORDER,
  INFO_ORDER,
  KNOWN_BUCKETS,
  WARNING_ORDER,
  appendLintFixLastOp,
  lintReadVault,
  lintVaultOutput,
  readMirrorHintLines,
  severityForBucket,
  summarizeLintOutput,
} from "./helpers.js";
import { collectLintErrorFingerprints } from "./fingerprints.js";
import { LINT_RULES } from "./rules.js";

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
  let exitCode: ExitCodeValue = ExitCode.OK;
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
  if (input.fix) appendLintFixLastOp(input.vault, fixed);
  return {
    exitCode,
    result: ok(input.summary ? summarizeLintOutput(output, input.examplesLimit) : output),
  };
}

export class LintRunner {
  private rules: readonly LintRuleModule[];

  constructor(rules: readonly LintRuleModule[] = LINT_RULES) {
    this.rules = rules;
  }

  getRegisteredRules(): readonly LintRuleModule[] {
    return this.rules;
  }

  findRuleForBucket(bucketName: string): LintRuleModule | undefined {
    return this.rules.find((r) => r.id === bucketName || r.producedBuckets?.includes(bucketName));
  }

  run(input: LintSummaryInput): Promise<{ exitCode: number; result: Result<LintSummaryOutput> }>;
  run(input: LintInput): Promise<{ exitCode: number; result: Result<LintOutput> }>;
  async run(
    input: LintInput | LintSummaryInput
  ): Promise<{ exitCode: number; result: Result<LintOutput | LintSummaryOutput> }> {
    if (input.only && !(KNOWN_BUCKETS as readonly string[]).includes(input.only)) {
      return {
        exitCode: ExitCode.USAGE,
        result: {
          ok: false,
          error: "UNKNOWN_BUCKET",
          detail: `Unknown bucket "${input.only}". Valid: ${KNOWN_BUCKETS.join(", ")}`,
        },
      };
    }

    // Check for rule-specific fast path when --only is provided
    if (input.only) {
      const rule = this.findRuleForBucket(input.only);
      if (rule && rule.id === input.only && rule.runFastPath) {
        return rule.runFastPath(input);
      }
    }

    const shouldFix = (bucket: string): boolean => !!input.fix && (!input.only || input.only === bucket);
    const readVault = lintReadVault(input);
    const lintVault = readVault.readPath;

    const buckets: Record<string, unknown[]> = {};
    const fixed: string[] = [];
    const unresolved: string[] = [];

    const scanResult = await scanVault(lintVault);
    if (!scanResult.ok) {
      return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };
    }
    const scan = scanResult.data;
    const pageTextCache: PageTextCache = new Map();
    if (!input.fix) {
      await mapWithConcurrency(scan.allMarkdown, vaultIoConcurrency(), async (page) => {
        try {
          await readPageCached(page, pageTextCache);
        } catch {
          // Individual lint buckets keep their existing unreadable-page behavior.
        }
      });
    }

    const wikilinkResolver = buildWikilinkResolver(scan.allMarkdown);
    const cliSurface = buildCliSurface();
    const ctx: LintRuleContext = {
      vault: lintVault,
      scan,
      pageTextCache,
      days: input.days,
      lines: input.lines,
      logThreshold: input.logThreshold,
      wikilinkResolver,
      cliSurface,
    };

    // Run rules sequentially
    for (const rule of this.rules) {
      const ruleRes = await rule.run(ctx);
      for (const [kind, items] of Object.entries(ruleRes.buckets)) {
        if (items && items.length > 0) {
          if (buckets[kind]) {
            buckets[kind] = [...buckets[kind]!, ...items];
          } else {
            buckets[kind] = items;
          }
        }
      }
    }

    // Fix phase
    if (input.fix) {
      const fixCtx: RuleFixContext = {
        vault: lintVault,
        scan,
        pageTextCache,
        input,
        fixed,
        unresolved,
      };

      for (const rule of this.rules) {
        const produced = rule.producedBuckets ?? [rule.id];
        for (const bucketName of produced) {
          if (shouldFix(bucketName) && buckets[bucketName] && rule.fix) {
            const remaining = await rule.fix(fixCtx, buckets[bucketName]!);
            if (remaining && remaining.length > 0) {
              buckets[bucketName] = remaining;
            } else {
              delete buckets[bucketName];
            }
          }
        }
      }
    }

    const errorOut: Bucket[] = ERROR_ORDER.flatMap((k) => (buckets[k] ? [{ kind: k, items: buckets[k]! }] : []));
    const warningOut: Bucket[] = WARNING_ORDER.flatMap((k) =>
      buckets[k] ? [{ kind: k, items: buckets[k]! }] : []
    );
    const infoOut: Bucket[] = INFO_ORDER.flatMap((k) => (buckets[k] ? [{ kind: k, items: buckets[k]! }] : []));

    // --only: filter to a single bucket
    if (input.only) {
      const match = [...errorOut, ...warningOut, ...infoOut].filter((b) => b.kind === input.only);
      return outputForOnlyBucket(input, match, fixed, unresolved, readVault);
    }

    const summary = {
      errors: errorOut.reduce((n, b) => n + b.items.length, 0),
      warnings: warningOut.reduce((n, b) => n + b.items.length, 0),
      info: infoOut.reduce((n, b) => n + b.items.length, 0),
    };

    let exitCode: number = ExitCode.OK;
    if (summary.errors > 0) exitCode = ExitCode.LINT_HAS_ERRORS;
    else if (summary.warnings > 0 || summary.info > 0) exitCode = ExitCode.LINT_HAS_WARNINGS;

    const vault = lintVaultOutput(input, readVault);
    const hintLines: string[] = [];
    hintLines.push(...readMirrorHintLines(vault));
    if (summary.errors > 0) hintLines.push(`errors: ${summary.errors}`);
    if (summary.warnings > 0) hintLines.push(`warnings: ${summary.warnings}`);
    if (summary.info > 0) hintLines.push(`info: ${summary.info}`);
    const allBuckets = [...errorOut, ...warningOut, ...infoOut];
    for (const b of allBuckets) {
      hintLines.push(`  ${b.kind}: ${b.items.length}`);
    }
    if (hintLines.length === 0) hintLines.push("0 errors, 0 warnings, 0 info");

    if (input.fix) appendLintFixLastOp(input.vault, fixed);

    const output: LintOutput = {
      vault,
      summary,
      by_severity: { error: errorOut, warning: warningOut, info: infoOut },
      fixed: fixed,
      unresolved: unresolved,
      humanHint: hintLines.join("\n"),
    };
    return {
      exitCode,
      result: ok(input.summary ? summarizeLintOutput(output, input.examplesLimit) : output),
    };
  }
}

export const defaultLintRunner = new LintRunner();

export function runLint(input: LintSummaryInput): Promise<{ exitCode: number; result: Result<LintSummaryOutput> }>;
export function runLint(input: LintInput): Promise<{ exitCode: number; result: Result<LintOutput> }>;
export function runLint(
  input: LintInput | LintSummaryInput
): Promise<{ exitCode: number; result: Result<LintOutput | LintSummaryOutput> }> {
  return defaultLintRunner.run(input as LintInput);
}

/**
 * Compare outgoing vault lint errors against a base git ref (default origin/main).
 * Base tree is exported via `git archive` into a temporary directory (no worktree).
 * Fail closed when base ref is missing/malformed or archive fails.
 */
export async function runSyncLintDelta(
  input: SyncLintDeltaInput
): Promise<{ exitCode: number; result: Result<SyncLintDeltaOutput> }> {
  const { mkdtempSync, rmSync, existsSync: fsExists } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");

  const vault = input.vault;
  const baseRef = input.baseRef ?? "origin/main";
  const days = input.days ?? 90;
  const lines = input.lines ?? 200;
  const logThreshold = input.logThreshold ?? 500;

  if (!fsExists(pathJoin(vault, ".git"))) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("NOT_A_GIT_REPO", { path: vault }),
    };
  }

  // Verify base ref resolves
  try {
    execFileSync("git", ["rev-parse", "--verify", baseRef], {
      cwd: vault,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: err("LINT_DELTA_BASE_UNAVAILABLE", {
        baseRef,
        message: `base ref ${baseRef} does not resolve — fail closed`,
      }),
    };
  }

  // Lint outgoing tree
  const fullLint = await runLint({ vault, days, lines, logThreshold });
  if (!fullLint.result.ok) {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: err("LINT_DELTA_FULL_FAILED", { detail: fullLint.result }),
    };
  }
  const fullOutput = fullLint.result.data as LintOutput;
  // When summary mode is not requested, data is LintOutput with by_severity.
  // If summary was returned somehow, fail closed.
  if (!("by_severity" in fullOutput) || !fullOutput.by_severity) {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: err("LINT_DELTA_MALFORMED", { message: "full lint missing by_severity" }),
    };
  }
  const fullFps = collectLintErrorFingerprints(fullOutput);

  // Export base tree to temp dir via git archive
  const tmpRoot = mkdtempSync(pathJoin(tmpdir(), "skillwiki-lint-delta-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", baseRef], {
      cwd: vault,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-"], {
      cwd: tmpRoot,
      input: archive,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Minimal SCHEMA.md check — lint requires vault shape
    if (!fsExists(pathJoin(tmpRoot, "SCHEMA.md"))) {
      // Still attempt lint; runLint will return VAULT_PATH_INVALID if needed.
    }

    const baseLint = await runLint({ vault: tmpRoot, days, lines, logThreshold });
    if (!baseLint.result.ok) {
      // Base vault may be incomplete; fail closed rather than skip.
      return {
        exitCode: ExitCode.LINT_HAS_ERRORS,
        result: err("LINT_DELTA_BASE_LINT_FAILED", {
          baseRef,
          detail: baseLint.result,
        }),
      };
    }
    const baseOutput = baseLint.result.data as LintOutput;
    if (!("by_severity" in baseOutput) || !baseOutput.by_severity) {
      return {
        exitCode: ExitCode.LINT_HAS_ERRORS,
        result: err("LINT_DELTA_MALFORMED", { message: "base lint missing by_severity" }),
      };
    }
    const baseFps = collectLintErrorFingerprints(baseOutput);

    const newFps: string[] = [];
    const resolvedFps: string[] = [];
    for (const fp of fullFps) {
      if (!baseFps.has(fp)) newFps.push(fp);
    }
    for (const fp of baseFps) {
      if (!fullFps.has(fp)) resolvedFps.push(fp);
    }
    newFps.sort();
    resolvedFps.sort();
    const fullList = [...fullFps].sort();

    const output: SyncLintDeltaOutput = {
      full_errors: fullFps.size,
      base_errors: baseFps.size,
      new_errors: newFps.length,
      resolved_errors: resolvedFps.length,
      full_fingerprints: fullList,
      new_fingerprints: newFps,
      resolved_fingerprints: resolvedFps,
      base_ref: baseRef,
      humanHint:
        newFps.length > 0
          ? `lint delta: ${newFps.length} new error(s) vs ${baseRef} (full=${fullFps.size}, base=${baseFps.size}, resolved=${resolvedFps.length})`
          : fullFps.size > 0
            ? `lint delta: 0 new errors vs ${baseRef}; inherited full_errors=${fullFps.size} (base=${baseFps.size}, resolved=${resolvedFps.length})`
            : `lint delta: clean (0 errors) vs ${baseRef}`,
    };

    const exitCode =
      output.new_errors > 0
        ? ExitCode.LINT_HAS_ERRORS
        : fullLint.exitCode === ExitCode.LINT_HAS_WARNINGS
          ? ExitCode.LINT_HAS_WARNINGS
          : ExitCode.OK;

    return { exitCode, result: ok(output) };
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: err("LINT_DELTA_ARCHIVE_FAILED", {
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
