import { ok, ExitCode, type ExitCodeValue, type Result } from "@skillwiki/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { runDoctor, type CheckResult, type DoctorOutput } from "./doctor.js";
import { runLint, type LintBucketSummary, type LintSummaryOutput, type LintSeverity } from "./lint.js";

export type HealthStatus = "pass" | "info" | "warn" | "error" | "unknown";
export type CoverageState = "checked" | "skipped" | "not_applicable" | "unknown";
export type SyncMode = "optional" | "required" | "off";

interface CoverageEntry {
  state: CoverageState;
  status: HealthStatus;
  reason?: string;
}

interface HealthComponent<TSummary = unknown> {
  status: HealthStatus;
  blocking: boolean;
  summary: TSummary;
}

interface DoctorComponent extends HealthComponent<DoctorOutput["summary"]> {
  checks: Array<Pick<CheckResult, "id" | "status" | "detail">>;
}

interface LintComponent extends HealthComponent<LintSummaryOutput["summary"]> {
  buckets: LintBucketSummary[];
  details_included: false;
  truncated: false;
}

interface VaultSyncComponent extends HealthComponent<{ pass: number; info: number; warn: number; error: number; skipped: number }> {
  installed: boolean;
  checks: Array<Pick<CheckResult, "id" | "status" | "detail">>;
}

interface QueryReadinessComponent extends HealthComponent<{ score: number }> {
  signals: Array<{ id: string; status: HealthStatus; value: number | string }>;
}

export interface RiskFlag {
  id: string;
  status: HealthStatus;
  blocking: boolean;
  evidence: string[];
  suggested_commands: string[];
}

export interface HealthReport {
  schema_version: 1;
  policy_version: 1;
  tool: { name: "skillwiki"; version: string };
  generated_at: string;
  command_kind: "diagnostic";
  vault: { path: string; source: string };
  overall_status: HealthStatus;
  blocking_status: HealthStatus;
  advisory_status: HealthStatus;
  coverage: Record<string, CoverageEntry>;
  components: {
    doctor: DoctorComponent;
    lint: LintComponent;
    vault_sync: VaultSyncComponent;
    query_readiness: QueryReadinessComponent;
    source_freshness: HealthComponent<{ stale_pages: number; file_source_url: number; stale_sections: number }>;
  };
  risk_flags: RiskFlag[];
  details_included: false;
  truncated: false;
  mutated: false;
  post_commit_ran: false;
  report_complete: boolean;
  report_written: boolean;
  report_path?: string;
  warnings: Array<{ id: string; message: string }>;
  self_check: { status: "pass" | "error"; errors: string[] };
  humanHint: string;
}

export interface HealthInput {
  vault: string;
  vaultSource?: string;
  home: string;
  envValue: string | undefined;
  argv: string[];
  currentVersion: string;
  cwd?: string;
  sync?: SyncMode;
  noFail?: boolean;
  out?: string;
  examplesLimit?: number;
}

function statusFromCounts(counts: { error?: number; warn?: number; warnings?: number; info?: number }): HealthStatus {
  if ((counts.error ?? 0) > 0) return "error";
  if ((counts.warn ?? counts.warnings ?? 0) > 0) return "warn";
  if ((counts.info ?? 0) > 0) return "info";
  return "pass";
}

function maxStatus(statuses: HealthStatus[]): HealthStatus {
  const order: Record<HealthStatus, number> = { pass: 0, info: 1, warn: 2, error: 3, unknown: 4 };
  return statuses.reduce<HealthStatus>((max, status) => order[status] > order[max] ? status : max, "pass");
}

function bucketCount(buckets: LintBucketSummary[], kind: string): number {
  return buckets.find(bucket => bucket.kind === kind)?.count ?? 0;
}

function bucketEvidence(prefix: string, buckets: LintBucketSummary[], kinds: string[]): string[] {
  return kinds
    .map(kind => ({ kind, count: bucketCount(buckets, kind) }))
    .filter(item => item.count > 0)
    .map(item => `${prefix}.${item.kind}: ${item.count}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function lintCommand(vaultPath: string, args: string): string {
  return `skillwiki lint ${shellQuote(vaultPath)} ${args}`;
}

function deriveRiskFlags(lint: LintSummaryOutput, vaultSync: VaultSyncComponent, syncMode: SyncMode): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const integrityEvidence = bucketEvidence("lint", lint.buckets, [
    "broken_sources",
    "invalid_frontmatter",
    "broken_wikilinks",
    "raw_source_identity_conflict",
  ]);
  if (integrityEvidence.length > 0) {
    flags.push({
      id: "content_integrity_risk",
      status: "error",
      blocking: true,
      evidence: integrityEvidence,
      suggested_commands: [
        lintCommand(lint.vault.path, "--summary"),
        lintCommand(lint.vault.path, "--only broken_sources"),
      ],
    });
  }

  const retrievalEvidence = bucketEvidence("lint", lint.buckets, [
    "tag_not_in_taxonomy",
    "orphans",
    "orphaned_project_pages",
    "missing_overview",
  ]);
  if (retrievalEvidence.length > 0) {
    const hasError = bucketCount(lint.buckets, "tag_not_in_taxonomy") > 0;
    flags.push({
      id: "retrieval_quality_risk",
      status: hasError ? "error" : "warn",
      blocking: hasError,
      evidence: retrievalEvidence,
      suggested_commands: [lintCommand(lint.vault.path, "--summary")],
    });
  }

  const duplicationEvidence = bucketEvidence("lint", lint.buckets, [
    "raw_dedup",
    "raw_body_duplicate",
    "raw_subdirectory_duplicate",
  ]);
  if (duplicationEvidence.length > 0) {
    flags.push({
      id: "content_duplication_risk",
      status: "warn",
      blocking: false,
      evidence: duplicationEvidence,
      suggested_commands: [lintCommand(lint.vault.path, "--only raw_dedup")],
    });
  }

  const syncEvidence = vaultSync.checks
    .filter(check => check.status === "error" || check.status === "warn")
    .map(check => `vault_sync.${check.id}: ${check.status}`);
  if (syncEvidence.length > 0) {
    flags.push({
      id: "sync_visibility_risk",
      status: vaultSync.status === "error" ? "error" : "warn",
      blocking: syncMode === "required",
      evidence: syncEvidence,
      suggested_commands: ["vault-sync-install"],
    });
  }

  const backlogEvidence = bucketEvidence("lint", lint.buckets, [
    "stale_page",
    "page_too_large",
    "work_item_health",
    "log_rotate_needed",
  ]);
  if (backlogEvidence.length > 0) {
    flags.push({
      id: "maintenance_backlog",
      status: "warn",
      blocking: false,
      evidence: backlogEvidence,
      suggested_commands: [lintCommand(lint.vault.path, "--summary")],
    });
  }

  return flags;
}

function summarizeChecks(checks: CheckResult[]): { pass: number; info: number; warn: number; error: number; skipped: number } {
  return {
    pass: checks.filter(check => check.status === "pass").length,
    info: checks.filter(check => check.status === "info").length,
    warn: checks.filter(check => check.status === "warn").length,
    error: checks.filter(check => check.status === "error").length,
    skipped: checks.filter(check => /skipped/i.test(check.detail)).length,
  };
}

function classifyLog(path: string, id: string, label: string, okPattern: RegExp): CheckResult {
  if (!existsSync(path)) return { id, label, status: "warn", detail: `log file missing: ${path}` };
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (!last) return { id, label, status: "warn", detail: `log file empty: ${path}` };
  if (/fail|error/i.test(last)) return { id, label, status: "error", detail: last.slice(0, 120) };
  if (okPattern.test(last)) return { id, label, status: "pass", detail: last.slice(0, 120) };
  return { id, label, status: "warn", detail: last.slice(0, 120) };
}

function runVaultSyncHealth(home: string, syncMode: SyncMode): VaultSyncComponent {
  if (syncMode === "off") {
    return {
      status: "pass",
      blocking: false,
      installed: false,
      summary: { pass: 0, info: 0, warn: 0, error: 0, skipped: 1 },
      checks: [{ id: "vault_sync_skipped", status: "pass", detail: "vault-sync checks skipped by --sync off" }],
    };
  }

  const isMac = platform() === "darwin";
  const shareDir = isMac
    ? join(home, "Library", "Application Support", "vault-sync", "bin")
    : join(home, ".local", "share", "vault-sync", "bin");
  const logDir = isMac
    ? join(home, "Library", "Logs")
    : join(home, ".local", "state", "vault-sync", "log");
  const filterPath = join(home, ".config", "rclone", "wiki-push-filters.txt");
  const checks: CheckResult[] = [];

  const pushScript = join(shareDir, "wiki-push.sh");
  checks.push(existsSync(pushScript)
    ? { id: "vault_sync_installed", label: "Vault sync installed", status: "pass", detail: `Found: ${pushScript}` }
    : { id: "vault_sync_installed", label: "Vault sync installed", status: "error", detail: `Script missing: ${pushScript}` });

  if (isMac) {
    const pushPlist = join(home, "Library", "LaunchAgents", "com.karlchow.wiki-push.plist");
    const fetchPlist = join(home, "Library", "LaunchAgents", "com.karlchow.wiki-fetch.plist");
    checks.push(existsSync(pushPlist) && existsSync(fetchPlist)
      ? { id: "vault_sync_jobs_enabled", label: "Vault sync jobs enabled", status: "pass", detail: "launchd unit files present (read-only mode)" }
      : { id: "vault_sync_jobs_enabled", label: "Vault sync jobs enabled", status: "warn", detail: "launchd unit files missing (read-only mode)" });
    checks.push({ id: "vault_sync_fuse_refresh_job", label: "Vault sync fuse refresh job", status: "pass", detail: "macOS host — check skipped" });
  } else {
    const pushTimer = join(home, ".config", "systemd", "user", "wiki-push.timer");
    const fetchTimer = join(home, ".config", "systemd", "user", "wiki-fetch.timer");
    const fuseTimer = join(home, ".config", "systemd", "user", "wiki-fuse-refresh.timer");
    const fuseService = join(home, ".config", "systemd", "user", "wiki-fuse-refresh.service");
    checks.push(existsSync(pushTimer) && existsSync(fetchTimer)
      ? { id: "vault_sync_jobs_enabled", label: "Vault sync jobs enabled", status: "pass", detail: "systemd timer unit files present (read-only mode)" }
      : { id: "vault_sync_jobs_enabled", label: "Vault sync jobs enabled", status: "warn", detail: "systemd timer unit files missing (read-only mode)" });
    checks.push(existsSync(fuseTimer) && existsSync(fuseService)
      ? { id: "vault_sync_fuse_refresh_job", label: "Vault sync fuse refresh job", status: "pass", detail: "wiki-fuse-refresh unit files present (read-only mode)" }
      : { id: "vault_sync_fuse_refresh_job", label: "Vault sync fuse refresh job", status: "warn", detail: "wiki-fuse-refresh unit files missing (read-only mode)" });
  }

  checks.push(classifyLog(join(logDir, "wiki-push.log"), "vault_sync_last_push_age", "Vault sync last push recency", /OK push/));
  checks.push(classifyLog(join(logDir, "wiki-fetch.log"), "vault_sync_last_fetch_status", "Vault sync last fetch status", /NOTIFY|OK behind|OK/));

  if (!existsSync(filterPath)) {
    checks.push({ id: "vault_sync_filter_present", label: "Vault sync filter file present", status: "error", detail: `Filter missing: ${filterPath}` });
  } else {
    const content = readFileSync(filterPath, "utf8");
    const missing = ["remotely-save/data.json", ".skillwiki/sync.lock", ".claude/settings.local.json"].filter(item => !content.includes(item));
    checks.push(missing.length > 0
      ? { id: "vault_sync_filter_present", label: "Vault sync filter file present", status: "warn", detail: `Missing excludes: ${missing.join(", ")}` }
      : { id: "vault_sync_filter_present", label: "Vault sync filter file present", status: "pass", detail: "Required excludes present" });
  }

  checks.push({ id: "vault_sync_snapshot_guard", label: "Snapshot script guard", status: "pass", detail: "Not a snapshotter host — check skipped" });

  const summary = summarizeChecks(checks);
  return {
    status: statusFromCounts(summary),
    blocking: syncMode === "required",
    installed: checks.find(check => check.id === "vault_sync_installed")?.status === "pass",
    summary,
    checks: checks.map(check => ({ id: check.id, status: check.status, detail: check.detail })),
  };
}

function deriveQueryReadiness(lint: LintSummaryOutput): QueryReadinessComponent {
  const taxonomyErrors = bucketCount(lint.buckets, "tag_not_in_taxonomy");
  const brokenLinks = bucketCount(lint.buckets, "broken_wikilinks") + bucketCount(lint.buckets, "broken_sources");
  const orphanCount = bucketCount(lint.buckets, "orphans") + bucketCount(lint.buckets, "orphaned_project_pages");
  const missingOverview = bucketCount(lint.buckets, "missing_overview");
  const missingTldr = bucketCount(lint.buckets, "missing_tldr");
  let score = 100;
  score -= Math.min(40, taxonomyErrors * 2);
  score -= Math.min(30, brokenLinks * 10);
  score -= Math.min(20, orphanCount * 3);
  score -= Math.min(15, missingOverview);
  score -= Math.min(5, missingTldr);
  score = Math.max(0, score);
  const status: HealthStatus = taxonomyErrors > 0 || brokenLinks > 0 ? "error" : score < 80 ? "warn" : "pass";
  return {
    status,
    blocking: false,
    summary: { score },
    signals: [
      { id: "taxonomy_errors", status: taxonomyErrors > 0 ? "error" : "pass", value: taxonomyErrors },
      { id: "broken_links", status: brokenLinks > 0 ? "error" : "pass", value: brokenLinks },
      { id: "orphan_count", status: orphanCount > 0 ? "warn" : "pass", value: orphanCount },
      { id: "missing_overview", status: missingOverview > 0 ? "warn" : "pass", value: missingOverview },
      { id: "missing_tldr", status: missingTldr > 0 ? "info" : "pass", value: missingTldr },
    ],
  };
}

function selfCheckReport(report: Omit<HealthReport, "self_check" | "humanHint">): { status: "pass" | "error"; errors: string[] } {
  const errors: string[] = [];
  const lint = report.components.lint;
  const sumBySeverity = (severity: LintSeverity) => lint.buckets
    .filter(bucket => bucket.severity === severity)
    .reduce((sum, bucket) => sum + bucket.count, 0);
  if (lint.summary.errors !== sumBySeverity("error")) {
    errors.push(`lint.summary.errors=${lint.summary.errors} but error bucket counts sum to ${sumBySeverity("error")}`);
  }
  if (lint.summary.warnings !== sumBySeverity("warning")) {
    errors.push(`lint.summary.warnings=${lint.summary.warnings} but warning bucket counts sum to ${sumBySeverity("warning")}`);
  }
  if (lint.summary.info !== sumBySeverity("info")) {
    errors.push(`lint.summary.info=${lint.summary.info} but info bucket counts sum to ${sumBySeverity("info")}`);
  }
  for (const component of ["doctor", "lint", "vault_sync", "query_readiness", "source_freshness"]) {
    if (!report.coverage[component]) errors.push(`missing coverage entry for ${component}`);
  }
  for (const flag of report.risk_flags) {
    if (flag.evidence.length === 0) errors.push(`risk flag ${flag.id} has no evidence`);
  }
  return { status: errors.length > 0 ? "error" : "pass", errors };
}

function buildHumanHint(report: Omit<HealthReport, "humanHint">): string {
  const lines = [
    `vault: ${report.vault.path} (via ${report.vault.source})`,
    `overall: ${report.overall_status}`,
    `doctor: ${report.components.doctor.summary.pass} pass, ${report.components.doctor.summary.info} info, ${report.components.doctor.summary.warn} warn, ${report.components.doctor.summary.error} error`,
    `lint: ${report.components.lint.summary.errors} errors, ${report.components.lint.summary.warnings} warnings, ${report.components.lint.summary.info} info`,
  ];
  for (const bucket of report.components.lint.buckets) {
    lines.push(`  ${bucket.severity} ${bucket.kind}: ${bucket.count}`);
  }
  lines.push(`vault_sync: ${report.components.vault_sync.summary.pass} pass, ${report.components.vault_sync.summary.warn} warn, ${report.components.vault_sync.summary.error} error`);
  lines.push(`query_readiness: ${report.components.query_readiness.status} (${report.components.query_readiness.summary.score}/100)`);
  if (report.risk_flags.length > 0) {
    lines.push("risk flags:");
    for (const flag of report.risk_flags) {
      lines.push(`  ${flag.id}: ${flag.status}${flag.blocking ? " (blocking)" : ""}`);
    }
  }
  if (report.self_check.status === "error") {
    lines.push("self-check: error");
    for (const error of report.self_check.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}

function writeReport(out: string, report: HealthReport): void {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(ok(report), null, 2) + "\n", "utf8");
  renameSync(tmp, out);
}

export async function runHealth(input: HealthInput): Promise<{ exitCode: number; result: Result<HealthReport> }> {
  const syncMode = input.sync ?? "optional";
  const doctor = await runDoctor({
    home: input.home,
    envValue: input.envValue,
    argv: input.argv,
    currentVersion: input.currentVersion,
    cwd: input.cwd,
  });
  const lint = await runLint({
    vault: input.vault,
    source: input.vaultSource ?? "resolved",
    days: 90,
    lines: 200,
    logThreshold: 500,
    summary: true,
    examplesLimit: input.examplesLimit ?? 3,
  });

  if (!doctor.result.ok) return { exitCode: doctor.exitCode, result: doctor.result };
  if (!lint.result.ok) return { exitCode: lint.exitCode, result: lint.result };

  const doctorStatus = statusFromCounts(doctor.result.data.summary);
  const vaultSync = runVaultSyncHealth(input.home, syncMode);
  const queryReadiness = deriveQueryReadiness(lint.result.data);
  const sourceFreshness: HealthReport["components"]["source_freshness"] = {
    status: bucketCount(lint.result.data.buckets, "stale_page") > 0 || bucketCount(lint.result.data.buckets, "file_source_url") > 0 ? "warn" : "pass",
    blocking: false,
    summary: {
      stale_pages: bucketCount(lint.result.data.buckets, "stale_page"),
      file_source_url: bucketCount(lint.result.data.buckets, "file_source_url"),
      stale_sections: bucketCount(lint.result.data.buckets, "stale_sections"),
    },
  };

  const doctorComponent: DoctorComponent = {
    status: doctorStatus,
    blocking: false,
    summary: doctor.result.data.summary,
    checks: doctor.result.data.checks.map(check => ({ id: check.id, status: check.status, detail: check.detail })),
  };
  const lintComponent: LintComponent = {
    status: statusFromCounts({ error: lint.result.data.summary.errors, warnings: lint.result.data.summary.warnings, info: lint.result.data.summary.info }),
    blocking: true,
    summary: lint.result.data.summary,
    buckets: lint.result.data.buckets,
    details_included: false,
    truncated: false,
  };
  const riskFlags = deriveRiskFlags(lint.result.data, vaultSync, syncMode);
  const blockingStatuses: HealthStatus[] = [
    lintComponent.blocking ? lintComponent.status : "pass",
    vaultSync.blocking ? vaultSync.status : "pass",
    ...riskFlags.filter(flag => flag.blocking).map(flag => flag.status),
  ];
  const advisoryStatuses: HealthStatus[] = [
    doctorComponent.status,
    vaultSync.status,
    queryReadiness.status,
    sourceFreshness.status,
    ...riskFlags.filter(flag => !flag.blocking).map(flag => flag.status),
  ];
  const blockingStatus = maxStatus(blockingStatuses);
  const advisoryStatus = maxStatus(advisoryStatuses);

  const baseReport: Omit<HealthReport, "self_check" | "humanHint"> = {
    schema_version: 1,
    policy_version: 1,
    tool: { name: "skillwiki", version: input.currentVersion },
    generated_at: new Date().toISOString(),
    command_kind: "diagnostic",
    vault: { path: input.vault, source: input.vaultSource ?? "resolved" },
    overall_status: maxStatus([blockingStatus, advisoryStatus]),
    blocking_status: blockingStatus,
    advisory_status: advisoryStatus,
    coverage: {
      doctor: { state: "checked", status: doctorStatus },
      lint: { state: "checked", status: lintComponent.status },
      vault_sync: syncMode === "off" ? { state: "skipped", status: "pass", reason: "--sync off" } : { state: "checked", status: vaultSync.status },
      query_readiness: { state: "checked", status: queryReadiness.status },
      source_freshness: { state: "checked", status: sourceFreshness.status },
    },
    components: {
      doctor: doctorComponent,
      lint: lintComponent,
      vault_sync: vaultSync,
      query_readiness: queryReadiness,
      source_freshness: sourceFreshness,
    },
    risk_flags: riskFlags,
    details_included: false,
    truncated: false,
    mutated: false,
    post_commit_ran: false,
    report_complete: true,
    report_written: false,
    warnings: [],
  };

  if (input.out) {
    baseReport.report_path = input.out;
  }

  if (input.out && resolve(input.out).startsWith(resolve(input.vault) + "/")) {
    baseReport.warnings.push({
      id: "report_inside_vault",
      message: "health report was written inside the vault; this may create sync churn",
    });
  }

  const self_check = selfCheckReport(baseReport);
  const reportWithoutHint = {
    ...baseReport,
    self_check,
    overall_status: self_check.status === "error" ? "unknown" as const : baseReport.overall_status,
    report_complete: self_check.status === "error" ? false : baseReport.report_complete,
  };
  const report: HealthReport = {
    ...reportWithoutHint,
    humanHint: buildHumanHint(reportWithoutHint),
  };

  if (input.out) {
    report.report_written = true;
    writeReport(input.out, report);
  }

  let exitCode: ExitCodeValue = ExitCode.OK;
  if (!input.noFail) {
    if (report.self_check.status === "error") exitCode = ExitCode.INTERNAL_ERROR;
    else if (report.blocking_status === "error") exitCode = ExitCode.LINT_HAS_ERRORS;
    else if (report.blocking_status === "warn" || report.advisory_status === "warn" || report.advisory_status === "error") {
      exitCode = ExitCode.LINT_HAS_WARNINGS;
    }
  }

  return { exitCode, result: ok(report) };
}
