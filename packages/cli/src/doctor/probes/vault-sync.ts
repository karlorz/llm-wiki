import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { systemdPropertyFor } from "@skillwiki/shared";
import { resolveVaultSyncPullHelper } from "../../utils/vault-sync-helper.js";
import { listReviewRequiredOps } from "../../utils/operation-journal.js";
import type { CheckResult, DoctorContext, DoctorProbe, VaultSyncRuntimeConfig } from "../types.js";
import { check } from "./helpers.js";

function readPushResultState(stateFile: string): {
  exists: boolean;
  result?: string;
  reason?: string;
  timestamp?: string;
  duration?: string;
  malformed?: boolean;
} {
  if (!existsSync(stateFile)) return { exists: false };
  try {
    const content = readFileSync(stateFile, "utf8");
    let result: string | undefined;
    let reason: string | undefined;
    let timestamp: string | undefined;
    let duration: string | undefined;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k === "result") result = v;
      else if (k === "reason") reason = v;
      else if (k === "timestamp") timestamp = v;
      else if (k === "duration") duration = v;
    }
    if (result !== "ok" && result !== "refused") {
      return { exists: true, malformed: true, result, reason, timestamp, duration };
    }
    return { exists: true, result, reason, timestamp, duration };
  } catch {
    return { exists: true, malformed: true };
  }
}
export function readVaultSyncConfig(home: string): VaultSyncRuntimeConfig {
  try {
    const content = readFileSync(join(home, ".skillwiki", ".env"), "utf8");
    let installed = false;
    let role: string | undefined;
    let serviceScope: string | undefined;
    let snapshotScript: string | undefined;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (v.length === 0) continue;
      if (k === "vault_sync.installed" && v === "true") installed = true;
      if (k === "vault_sync.role") role = v;
      if (k === "vault_sync.service_scope") serviceScope = v;
      if (k === "vault_sync.snapshot_script") snapshotScript = v;
    }
    return { installed, role, serviceScope, snapshotScript };
  } catch {
    return { installed: false };
  }
}

interface SnapshotTimerProps {
  load_state: string | null;
  unit_file_state: string | null;
  active_state: string | null;
  sub_state: string | null;
  next_elapse: string | null;
  result: string | null;
}

interface SnapshotServiceProps {
  load_state: string | null;
  active_state: string | null;
  sub_state: string | null;
  result: string | null;
  exec_main_status: number | null;
  exec_main_code: number | null;
  active_enter_timestamp: string | null;
  inactive_enter_timestamp: string | null;
  exec_main_start_timestamp?: string | null;
  exec_main_exit_timestamp?: string | null;
}

function normalizeSystemdValue(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim();
  if (!v || v === "n/a" || v === "N/A") return undefined;
  return v;
}

function hasCompletedRunEvidence(...timestamps: Array<string | undefined | null>): boolean {
  return timestamps.some(t => normalizeSystemdValue(t ?? undefined) != null);
}

interface SnapshotFixture {
  schema_version: number;
  scenario_id: string;
  now: string;
  cadence_minutes: number;
  service_timeout_seconds: number;
  service_scope: "user" | "system";
  timer: SnapshotTimerProps;
  service: SnapshotServiceProps;
  log_records: string[];
}

function loadSnapshotFixture(env: NodeJS.ProcessEnv): SnapshotFixture | null {
  const path = env.VS_SNAPSHOT_HEALTH_FIXTURE;
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SnapshotFixture;
  } catch {
    return null;
  }
}

function systemctlShowProperty(scope: string, unit: string, prop: string): string | undefined {
  try {
    const cmd = scope === "system"
      ? `systemctl show ${unit} --property=${prop} --value`
      : `systemctl --user show ${unit} --property=${prop} --value`;
    const out = execSync(cmd, {
      encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
    });
    return normalizeSystemdValue(out);
  } catch {
    return undefined;
  }
}

function snapshotProp(
  kind: "timer" | "service",
  prop: string,
  fixture: SnapshotFixture | null,
  scope: string,
): string | undefined {
  if (fixture) {
    const bag = fixture[kind] as unknown as Record<string, unknown>;
    const v = bag[prop];
    return v == null ? undefined : String(v);
  }
  const unit = kind === "timer" ? "wiki-snapshot.timer" : "wiki-snapshot.service";
  const liveProp = systemdPropertyFor(prop);
  if (!liveProp) return undefined;
  return systemctlShowProperty(scope, unit, liveProp);
}

function parseIsoToMs(ts: string | undefined | null): number | null {
  if (!ts || ts === "MISSING") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function ageMinutes(nowMs: number, tsMs: number | null): number | null {
  if (tsMs == null) return null;
  return Math.floor((nowMs - tsMs) / 60000);
}

function checkPushAgeFromTimestamp(ts: string): CheckResult {
  const lastPush = new Date(ts).getTime();
  if (isNaN(lastPush)) {
    return check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
      `Unparseable push timestamp: ${ts}`);
  }
  const ageSec = (Date.now() - lastPush) / 1000;
  if (ageSec <= 180) {
    return check("pass", "vault_sync_last_push_age", "Vault sync last push recency",
      `Last push ${ageSec.toFixed(0)}s ago`);
  }
  return check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
    `Last push ${Math.round(ageSec)}s ago (>3 min)`);
}

function checkPushAgeFromLog(logDir: string, logFile: string): CheckResult {
  try {
    const logContent = readFileSync(logFile, "utf8");
    const lines = logContent.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      return check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
        "Log file is empty");
    }
    const lastLine = [...lines].reverse().find(line =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z (OK push|FAIL)/.test(line),
    );
    if (!lastLine) {
      const tail = lines[lines.length - 1]!;
      return check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
        `Last log entry: ${tail.slice(0, 80)}`);
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z FAIL/.test(lastLine)) {
      return check("error", "vault_sync_last_push_age", "Vault sync last push recency",
        `Last push failed: ${lastLine}`);
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z OK push/.test(lastLine)) {
      const tsMatch = lastLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
      if (tsMatch) {
        return checkPushAgeFromTimestamp(tsMatch[1]!);
      }
      return check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
        `Unparseable push line: ${lastLine.slice(0, 80)}`);
    }
    return check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
      `Last log entry: ${lastLine.slice(0, 80)}`);
  } catch {
    return existsSync(logDir)
      ? check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
        `Log file not found at ${logFile}`)
      : check("error", "vault_sync_last_push_age", "Vault sync last push recency",
        `Log directory not found at ${logDir}`);
  }
}

export function snapshotterHealthChecks(
  scope: string,
  logDir: string,
  env: NodeJS.ProcessEnv,
): CheckResult[] {
  const fixture = loadSnapshotFixture(env);
  const cadence = fixture ? fixture.cadence_minutes : parseInt(env.VS_SNAPSHOT_CADENCE_MINUTES ?? "30", 10) || 30;
  const timeout = fixture ? fixture.service_timeout_seconds : parseInt(env.VS_SNAPSHOT_SERVICE_TIMEOUT_SECONDS ?? "900", 10) || 900;
  const injectedNowMs = env.VS_SNAPSHOT_HEALTH_NOW
    ? Date.parse(env.VS_SNAPSHOT_HEALTH_NOW)
    : Number.NaN;
  const nowMs = fixture
    ? Date.parse(fixture.now)
    : Number.isFinite(injectedNowMs) ? injectedNowMs : Date.now();
  const warnAge = cadence * 2 + 15;
  const errorAge = cadence * 4 + 15;

  const tUnitfile = snapshotProp("timer", "unit_file_state", fixture, scope);
  const tActive = snapshotProp("timer", "active_state", fixture, scope);
  const tNext = snapshotProp("timer", "next_elapse", fixture, scope);
  let jobs: CheckResult;
  if (tUnitfile == null && tActive == null) {
    jobs = check("warn", "vault_sync_jobs_enabled", "Vault sync jobs enabled", "wiki-snapshot.timer properties unavailable (read-only)");
  } else if (tUnitfile === "enabled" && tActive === "active" && tNext) {
    jobs = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `wiki-snapshot.timer enabled+active, next=${tNext} (${scope})`);
  } else {
    jobs = check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `wiki-snapshot.timer not eligible: unit_file_state=${tUnitfile ?? "missing"} active_state=${tActive ?? "missing"} next_elapse=${tNext ?? "missing"} (${scope})`);
  }

  const sActive = snapshotProp("service", "active_state", fixture, scope) ?? null;
  const sResult = snapshotProp("service", "result", fixture, scope) ?? null;
  const sExecMainStatus = snapshotProp("service", "exec_main_status", fixture, scope);
  const sActiveEnter = snapshotProp("service", "active_enter_timestamp", fixture, scope) ?? null;
  const sInactiveEnter = snapshotProp("service", "inactive_enter_timestamp", fixture, scope) ?? null;
  const sExecMainStart = snapshotProp("service", "exec_main_start_timestamp", fixture, scope) ?? null;
  const sExecMainExit = snapshotProp("service", "exec_main_exit_timestamp", fixture, scope) ?? null;
  const completedEvidence = hasCompletedRunEvidence(sExecMainExit, sInactiveEnter, sActiveEnter);
  let serviceResult: CheckResult;
  if (sActive == null && sResult == null) {
    serviceResult = check("warn", "vault_sync_snapshot_service_result", "Vault sync snapshot service result", "wiki-snapshot.service properties unavailable (read-only)");
  } else if (sActive === "active" || sActive === "activating") {
    const startMs = parseIsoToMs(sExecMainStart) ?? parseIsoToMs(sActiveEnter);
    const runSec = startMs == null ? null : Math.floor((nowMs - startMs) / 1000);
    if (runSec != null && runSec > timeout) {
      serviceResult = check("error", "vault_sync_snapshot_service_result", "Vault sync snapshot service result", `wiki-snapshot.service running ${runSec}s beyond timeout ${timeout}s`);
    } else {
      serviceResult = check("pass", "vault_sync_snapshot_service_result", "Vault sync snapshot service result", `wiki-snapshot.service in progress (running ${runSec ?? "?"}s)`);
    }
  } else if (sResult === "success" && (sExecMainStatus ?? "0") === "0" && completedEvidence) {
    serviceResult = check("pass", "vault_sync_snapshot_service_result", "Vault sync snapshot service result", "wiki-snapshot.service result=success ExecMainStatus=0");
  } else if (sResult === "failed" || (sExecMainStatus != null && sExecMainStatus !== "0")) {
    serviceResult = check("error", "vault_sync_snapshot_service_result", "Vault sync snapshot service result", `wiki-snapshot.service result=${sResult ?? "missing"} ExecMainStatus=${sExecMainStatus ?? "missing"}`);
  } else {
    serviceResult = check("warn", "vault_sync_snapshot_service_result", "Vault sync snapshot service result", `wiki-snapshot.service result=${sResult ?? "missing"} (never ran or unrecognized)`);
  }

  let completionTs: string | null = null;
  let completionOutcome = "unknown";
  const logRecords = fixture ? fixture.log_records : (() => {
    try {
      const content = readFileSync(join(logDir, "wiki-snapshot.log"), "utf8");
      return content.split(/\r?\n/).filter(Boolean);
    } catch { return []; }
  })();
  for (let i = logRecords.length - 1; i >= 0; i--) {
    const m = logRecords[i]!.match(/SNAPSHOT_COMPLETE schema=v1 .*ts=(\S+)/);
    if (m) {
      completionTs = m[1]!;
      const om = logRecords[i]!.match(/outcome=(\S+)/);
      if (om) completionOutcome = om[1]!;
      break;
    }
  }
  let freshness: CheckResult;
  if (!completionTs || completionTs === "MISSING") {
    if (sActive === "active" || sActive === "activating") {
      freshness = check("warn", "vault_sync_last_push_age", "Vault sync last snapshot recency", "snapshot in progress; no prior canonical completion record");
    } else {
      freshness = check("error", "vault_sync_last_push_age", "Vault sync last snapshot recency", "no canonical SNAPSHOT_COMPLETE record found");
    }
  } else {
    const ageMin = ageMinutes(nowMs, parseIsoToMs(completionTs));
    if (ageMin == null) {
      freshness = check("error", "vault_sync_last_push_age", "Vault sync last snapshot recency", `unparseable completion timestamp: ${completionTs}`);
    } else if (ageMin <= warnAge) {
      freshness = check("pass", "vault_sync_last_push_age", "Vault sync last snapshot recency", `last snapshot ${ageMin}m ago (outcome=${completionOutcome}, <=${warnAge}m)`);
    } else if (ageMin <= errorAge) {
      freshness = check("warn", "vault_sync_last_push_age", "Vault sync last snapshot recency", `last snapshot ${ageMin}m ago (outcome=${completionOutcome}, >${warnAge}m)`);
    } else {
      freshness = check("error", "vault_sync_last_push_age", "Vault sync last snapshot recency", `last snapshot ${ageMin}m ago (outcome=${completionOutcome}, >${errorAge}m)`);
    }
  }
  if (serviceResult.status === "error" && sActive !== "active" && sActive !== "activating") {
    freshness = check("error", "vault_sync_last_push_age", "Vault sync last snapshot recency", `latest service result failed: ${serviceResult.detail}`);
  }

  let failCount = 0;
  let mostRecentFail = "";
  for (let i = logRecords.length - 1; i >= 0 && i >= logRecords.length - 60; i--) {
    const line = logRecords[i]!;
    if (/SNAPSHOT_COMPLETE schema=v1/.test(line)) break;
    if (/ERROR/.test(line)) {
      failCount++;
      if (!mostRecentFail) {
        const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
        mostRecentFail = m ? m[1]! : "unknown";
      }
    }
  }
  const consecutiveFailures: CheckResult = failCount >= 2
    ? check("error", "vault_sync_snapshot_consecutive_failures", "Vault sync snapshot consecutive failures", `${failCount} consecutive snapshot failure(s); most recent: ${mostRecentFail || "unknown"}`)
    : check("pass", "vault_sync_snapshot_consecutive_failures", "Vault sync snapshot consecutive failures", `${failCount} consecutive failure(s) in recent window (recurrence threshold: 2)`);

  return [jobs, serviceResult, freshness, consecutiveFailures];
}

interface VaultSyncInput {
  home: string;
  vaultSyncInstalled: boolean;
  vaultSyncRole?: string;
  vaultSyncServiceScope?: string;
  os?: string;
  logDir?: string;
  cacheDir?: string;
  shareDir?: string;
  filterPath?: string;
  snapshotScriptPath?: string;
  env?: NodeJS.ProcessEnv;
}

function vaultSyncChecks(input: VaultSyncInput): CheckResult[] {
  const os = input.os ?? platform();
  const home = input.home;

  if (!input.vaultSyncInstalled) {
    const skip = (id: string, label: string) =>
      check("pass", id, label, "vault-sync not installed — check skipped");
    return [
      skip("vault_sync_installed", "Vault sync installed"),
      skip("vault_sync_jobs_enabled", "Vault sync jobs enabled"),
      skip("vault_sync_snapshot_service_result", "Vault sync snapshot service result"),
      skip("vault_sync_last_push_age", "Vault sync last push recency"),
      skip("vault_sync_last_push_result", "Vault sync last push result"),
      skip("vault_sync_snapshot_consecutive_failures", "Vault sync snapshot consecutive failures"),
      skip("vault_sync_last_fetch_status", "Vault sync last fetch status"),
      skip("vault_sync_filter_present", "Vault sync filter file present"),
      skip("vault_sync_snapshot_guard", "Snapshot script guard"),
    ];
  }

  const isMac = os === "darwin";
  const logDir =
    input.logDir ??
    (isMac
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state", "vault-sync", "log"));
  const cacheDir =
    input.cacheDir ??
    (isMac
      ? join(home, "Library", "Caches", "vault-sync")
      : join(home, ".cache", "vault-sync"));
  const shareDir =
    input.shareDir ??
    (isMac
      ? join(home, "Library", "Application Support", "vault-sync", "bin")
      : join(home, ".local", "share", "vault-sync", "bin"));
  const filterPath =
    input.filterPath ?? join(home, ".config", "rclone", "wiki-push-filters.txt");
  const packagedSnapshotPath = join(shareDir, "wiki-snapshot.sh");
  const legacySnapshotPath = "/root/.hermes/scripts/wiki-snapshot-v3.sh";
  const snapshotPath =
    input.snapshotScriptPath ??
    (existsSync(packagedSnapshotPath) ? packagedSnapshotPath : legacySnapshotPath);

  if (input.vaultSyncRole === "snapshotter") {
    const c1 = existsSync(snapshotPath)
      ? check("pass", "vault_sync_installed", "Vault sync installed", `Found snapshot script: ${snapshotPath}`)
      : check("error", "vault_sync_installed", "Vault sync installed", `Snapshot script not found at ${snapshotPath}`);

    const serviceScope = input.vaultSyncServiceScope ?? "user";
    const healthChecks = snapshotterHealthChecks(serviceScope, logDir, input.env ?? process.env);

    const cFetch = check("pass", "vault_sync_last_fetch_status", "Vault sync last fetch status",
      "Snapshotter host — leaf wiki-fetch-notify log not applicable");
    const c4 = check("pass", "vault_sync_filter_present", "Vault sync filter file present",
      "Snapshotter host — leaf wiki-push filter not applicable");

    let c5: CheckResult;
    try {
      if (!existsSync(snapshotPath)) {
        c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
          `Snapshot script not found at ${snapshotPath}`);
      } else {
        const content = readFileSync(snapshotPath, "utf8");
        if (!content.includes("--max-delete")) {
          c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
            `${snapshotPath} is missing --max-delete guard — dangerous without it`);
        } else {
          c5 = check("pass", "vault_sync_snapshot_guard", "Snapshot script guard",
            `--max-delete present in ${snapshotPath}`);
        }
      }
    } catch {
      c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
        `Cannot read ${snapshotPath}`);
    }

    return [c1, ...healthChecks, cFetch, c4, c5];
  }

  const pushScriptPath = join(shareDir, "wiki-push.sh");
  const c1 = existsSync(pushScriptPath)
    ? check("pass", "vault_sync_installed", "Vault sync installed", `Found: ${pushScriptPath}`)
    : check("error", "vault_sync_installed", "Vault sync installed", `Script not found at ${pushScriptPath} — run vault-sync-install`);

  let c2: CheckResult;
  try {
    if (isMac) {
      const uidStr = execSync("id -u", {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const uid = parseInt(uidStr, 10);
      execSync(`launchctl print gui/${uid}/com.karlchow.wiki-push`, {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "ignore", "ignore"],
      });
      c2 = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
        "launchd: com.karlchow.wiki-push loaded");
    } else {
      const out = execSync("systemctl --user is-enabled wiki-push.timer", {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (out === "enabled") {
        c2 = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
          "systemd: wiki-push.timer enabled");
      } else {
        c2 = check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
          `systemd: wiki-push.timer is ${out} — run vault-sync-install`);
      }
    }
  } catch {
    c2 = check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
      "Scheduler check failed — run vault-sync-install");
  }

  const stateFile = join(cacheDir, "wiki-push-result.state");
  const pushState = readPushResultState(stateFile);

  const logFile = join(logDir, "wiki-push.log");
  let c3: CheckResult;
  if (pushState.exists && !pushState.malformed) {
    if (pushState.result === "refused") {
      const reasonSuffix = pushState.reason ? `: ${pushState.reason}` : "";
      c3 = check("error", "vault_sync_last_push_age", "Vault sync last push recency",
        `Last push refused${reasonSuffix}`);
    } else if (pushState.result === "ok") {
      if (pushState.timestamp) {
        c3 = checkPushAgeFromTimestamp(pushState.timestamp);
      } else {
        c3 = check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
          "State file missing timestamp");
      }
    } else {
      c3 = checkPushAgeFromLog(logDir, logFile);
    }
  } else {
    c3 = checkPushAgeFromLog(logDir, logFile);
  }

  let cPushResult: CheckResult;
  if (pushState.exists) {
    if (pushState.malformed) {
      cPushResult = check("warn", "vault_sync_last_push_result", "Vault sync last push result",
        `malformed state file: ${stateFile}`);
    } else if (pushState.result === "ok") {
      cPushResult = check("pass", "vault_sync_last_push_result", "Vault sync last push result",
        `result=ok timestamp=${pushState.timestamp ?? ""}`);
    } else if (pushState.result === "refused") {
      cPushResult = check("error", "vault_sync_last_push_result", "Vault sync last push result",
        `result=refused reason=${pushState.reason ?? ""} timestamp=${pushState.timestamp ?? ""}`);
    } else {
      cPushResult = check("warn", "vault_sync_last_push_result", "Vault sync last push result",
        `malformed state file: ${stateFile}`);
    }
  } else {
    cPushResult = check("warn", "vault_sync_last_push_result", "Vault sync last push result",
      `no push result state file (push may not have run yet): ${stateFile}`);
  }

  const fetchLogFile = join(logDir, "wiki-fetch.log");
  let cFetch: CheckResult;
  try {
    const logContent = readFileSync(fetchLogFile, "utf8");
    const lines = logContent.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      cFetch = check("warn", "vault_sync_last_fetch_status", "Vault sync last fetch status",
        "Fetch log file is empty");
    } else {
      const lastLine = lines[lines.length - 1];
      if (/fetch failed/i.test(lastLine)) {
        cFetch = check("error", "vault_sync_last_fetch_status", "Vault sync last fetch status",
          `Last fetch failed: ${lastLine.slice(0, 100)}`);
      } else if (/OK/.test(lastLine)) {
        cFetch = check("pass", "vault_sync_last_fetch_status", "Vault sync last fetch status",
          lastLine.slice(0, 100));
      } else {
        cFetch = check("warn", "vault_sync_last_fetch_status", "Vault sync last fetch status",
          `Last fetch log entry: ${lastLine.slice(0, 80)}`);
      }
    }
  } catch {
    cFetch = check("warn", "vault_sync_last_fetch_status", "Vault sync last fetch status",
      `Fetch log not found at ${fetchLogFile}`);
  }

  let c4: CheckResult;
  try {
    if (!existsSync(filterPath)) {
      c4 = check("error", "vault_sync_filter_present", "Vault sync filter file present",
        `Filter file not found at ${filterPath}`);
    } else {
      const content = readFileSync(filterPath, "utf8");
      const requiredExcludes = [
        "remotely-save/data.json",
        ".skillwiki/sync.lock",
        ".skillwiki/memory/",
        ".skillwiki/memory-topics.json",
        ".claude/settings.local.json",
      ];
      const missing = requiredExcludes.filter(ex => !content.includes(ex));
      if (missing.length > 0) {
        c4 = check("warn", "vault_sync_filter_present", "Vault sync filter file present",
          `Missing required excludes: ${missing.join(", ")}`);
      } else {
        c4 = check("pass", "vault_sync_filter_present", "Vault sync filter file present",
          `Found with required excludes at ${filterPath}`);
      }
    }
  } catch {
    c4 = check("error", "vault_sync_filter_present", "Vault sync filter file present",
      `Cannot read filter file at ${filterPath}`);
  }

  let c5: CheckResult;
  if (input.vaultSyncRole !== "snapshotter") {
    c5 = check("pass", "vault_sync_snapshot_guard", "Snapshot script guard",
      "Not a snapshotter host — check skipped");
  } else {
    try {
      if (!existsSync(snapshotPath)) {
        c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
          `Snapshot script not found at ${snapshotPath}`);
      } else {
        const content = readFileSync(snapshotPath, "utf8");
        if (!content.includes("--max-delete")) {
          c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
            `${snapshotPath} is missing --max-delete guard — dangerous without it`);
        } else {
          c5 = check("pass", "vault_sync_snapshot_guard", "Snapshot script guard",
            `--max-delete present in ${snapshotPath}`);
        }
      }
    } catch {
      c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
        `Cannot read ${snapshotPath}`);
    }
  }

  return [c1, c2, c3, cPushResult, cFetch, c4, c5];
}

function checkVaultSyncPullHelper(home: string, env: NodeJS.ProcessEnv): CheckResult {
  const path = resolveVaultSyncPullHelper({
    vault: "",
    home,
    env: env as Record<string, string | undefined>,
  });
  if (path) {
    return check("pass", "vault_sync_pull_helper", "Vault-sync pull helper", `Resolved: ${path}`);
  }
  return check(
    "error",
    "vault_sync_pull_helper",
    "Vault-sync pull helper",
    "Not found — install skillwiki@0.10.1+, redeploy vault-sync, or set SKILLWIKI_VAULT_SYNC_PULL_HELPER",
  );
}

function checkVaultSyncReviewRequiredJournals(vaultPath: string | undefined): CheckResult {
  if (!vaultPath || !existsSync(join(vaultPath, ".git"))) {
    return check("pass", "vault_sync_review_required_journals", "Review-required journals", "No git vault — check skipped");
  }
  try {
    const ops = listReviewRequiredOps(vaultPath);
    if (ops.length === 0) {
      return check("pass", "vault_sync_review_required_journals", "Review-required journals", "None");
    }
    const sample = ops[0]?.opId ?? "?";
    return check(
      "warn",
      "vault_sync_review_required_journals",
      "Review-required journals",
      `${ops.length} handoff(s); oldest/sample: ${sample} — if worktree clean: skillwiki sync journal clear-stale --dry-run`,
    );
  } catch {
    return check("pass", "vault_sync_review_required_journals", "Review-required journals", "Could not read journals — check skipped");
  }
}

export const vaultSyncProbe: DoctorProbe = {
  id: "vault_sync",
  run(ctx: DoctorContext): CheckResult[] {
    const checks: CheckResult[] = [];
    checks.push(...vaultSyncChecks({
      home: ctx.input.home,
      vaultSyncInstalled: ctx.vsConfig.installed,
      vaultSyncRole: ctx.vsConfig.role,
      vaultSyncServiceScope: ctx.vsConfig.serviceScope,
      snapshotScriptPath: ctx.vsConfig.snapshotScript,
      env: ctx.input.env ?? process.env,
    }));
    checks.push(checkVaultSyncPullHelper(ctx.input.home, ctx.input.env ?? process.env));
    checks.push(checkVaultSyncReviewRequiredJournals(ctx.resolvedPath));
    return checks;
  },
};
