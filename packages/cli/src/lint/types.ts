import type { Result } from "@skillwiki/shared";
import type { PageTextCache, VaultScan, VaultPage } from "../utils/vault.js";
import type { WikilinkResolver } from "../utils/wikilink-resolver.js";

export type LintSeverity = "error" | "warning" | "info";

export interface Bucket {
  kind: string;
  items: unknown[];
}

export interface LintBucketSummary {
  kind: string;
  severity: LintSeverity;
  count: number;
  examples: string[];
  examples_limit: number;
  sample_truncated: boolean;
  details_command: string;
}

export interface LintVaultOutput {
  path: string;
  source: string;
  read_path: string;
  read_mirror: boolean;
}

export interface LintOutput {
  vault: LintVaultOutput;
  summary: { errors: number; warnings: number; info: number };
  by_severity: { error: Bucket[]; warning: Bucket[]; info: Bucket[] };
  fixed: string[];
  unresolved: string[];
  humanHint: string;
}

export interface LintSummaryOutput {
  vault: LintVaultOutput;
  summary: { errors: number; warnings: number; info: number };
  buckets: LintBucketSummary[];
  details_included: false;
  truncated: false;
  fixed: string[];
  unresolved: string[];
  humanHint: string;
}

export interface LintBaseInput {
  vault: string;
  source?: string;
  days: number;
  lines: number;
  logThreshold: number;
  fix?: boolean;
  only?: string;
}

export interface LintInput extends LintBaseInput {
  summary?: false;
}

export interface LintSummaryInput extends LintBaseInput {
  summary: true;
  examplesLimit?: number;
}

export interface LintReadVault {
  readPath: string;
  readMirror: boolean;
}

export interface FileSourceUrlFindings {
  fileSourceUrlFlags: Set<string>;
  fileSourceUrlFrontmatterFlags: Set<string>;
  rawIdentityConflicts: unknown[];
}

export interface LintRuleContext {
  vault: string;
  scan: VaultScan;
  pageTextCache: PageTextCache;
  days: number;
  lines: number;
  logThreshold: number;
  wikilinkResolver: WikilinkResolver;
  cliSurface: Map<string, Set<string>>;
  // Shared parsed/cached state across rules during a run
  parsedPagesCache?: {
    allPages?: Array<{
      page: VaultPage;
      sensitiveFlags: unknown[];
      conflictMarkers: Array<{ path: string; line: number; message: string }>;
      fmYamlInvalid: { path: string; message: string } | null;
    }>;
    fileSourceUrlFindings?: FileSourceUrlFindings;
    typedPages?: Array<{
      page: VaultPage;
      legacyPages: string[];
      orphanedPages: string[];
      structFlags: string[];
      dupFrontmatter: string[];
      noOverview: string[];
      fmWikilinkFlags: string[];
      wikilinkCitationFlags: string[];
      brokenSourceFlags: string[];
      missingTldrFlags: string[];
      missingDiagramFlags: string[];
    }>;
  };
}

export type RuleFixContext = {
  vault: string;
  scan: VaultScan;
  pageTextCache: PageTextCache;
  input: LintInput | LintSummaryInput;
  fixed: string[];
  unresolved: string[];
};

export interface LintRuleResult {
  buckets: Record<string, unknown[]>;
}

export interface LintRuleModule {
  id: string;
  severity: LintSeverity;
  /** Primary bucket name produced by this rule (defaults to id) */
  bucket?: string;
  /** Additional bucket names this rule can produce */
  producedBuckets?: readonly string[];
  run(ctx: LintRuleContext): Promise<LintRuleResult>;
  /** Optional custom fix logic when --fix is provided */
  fix?(ctx: RuleFixContext, currentBucketItems: unknown[]): Promise<unknown[] | undefined>;
  /** Optional fast-path execution when --only <id> is requested */
  runFastPath?(input: LintInput | LintSummaryInput): Promise<{ exitCode: number; result: Result<LintOutput | LintSummaryOutput> }>;
}

export interface SyncLintDeltaInput {
  vault: string;
  baseRef?: string;
  days?: number;
  lines?: number;
  logThreshold?: number;
}

export interface SyncLintDeltaOutput {
  full_errors: number;
  base_errors: number;
  new_errors: number;
  resolved_errors: number;
  full_fingerprints: string[];
  new_fingerprints: string[];
  resolved_fingerprints: string[];
  base_ref: string;
  humanHint: string;
}
