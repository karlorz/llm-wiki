/**
 * Re-export all lint functionality from the dedicated lint runner and rule modules.
 * This module is kept as a thin command adapter for backwards compatibility.
 */
export {
  runLint,
  runSyncLintDelta,
  lintIssueFingerprint,
  collectLintErrorFingerprints,
  summarizeLintOutput,
  type LintInput,
  type LintSummaryInput,
  type LintOutput,
  type LintSummaryOutput,
  type LintSeverity,
  type LintBucketSummary,
  type LintVaultOutput,
  type SyncLintDeltaInput,
  type SyncLintDeltaOutput,
  type Bucket,
} from "../lint/index.js";
