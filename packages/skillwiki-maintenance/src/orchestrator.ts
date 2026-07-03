import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionKind } from "@skillwiki/shared";
import { createCommandRunner } from "./command.js";
import { parseMaintenanceConfig, type MaintenanceConfig } from "./config.js";
import { runAgentMemoryTrendsDaily } from "./jobs/agent-memory-trends-daily.js";
import { runHealthSummary } from "./jobs/health-summary.js";
import { runSelfUpdateApply, runSelfUpdateCheck } from "./jobs/self-update-check.js";
import { runSessionBriefRefresh } from "./jobs/session-brief-refresh.js";
import { runVaultSyncPreflight } from "./jobs/vault-sync-preflight.js";
import { acquireLock } from "./lock.js";
import { resolveWorkflowProfile } from "./profiles.js";
import { err, ok, type CommandRunner, type JobCheck, type MaintenanceMode, type Result } from "./types.js";

export interface RunMaintenanceInput {
  fleetPath: string;
  hostId: string;
  lockDir: string;
  now: Date;
  mode?: MaintenanceMode;
  emit?: (event: MaintenanceEvent) => void;
  runCommand?: CommandRunner;
}

export interface MaintenanceEvent {
  ts: string;
  event: "start" | "job" | "skip" | "finish" | "error";
  host_id: string;
  job?: string;
  status?: string;
  reason?: string;
  details?: unknown;
}

export interface RunMaintenanceOutput {
  config: MaintenanceConfig;
  checks: JobCheck[];
}

export async function runStage1Maintenance(input: RunMaintenanceInput): Promise<Result<RunMaintenanceOutput>> {
  const parsed = parseMaintenanceConfig(readFileSync(input.fleetPath, "utf8"), input.hostId, input.fleetPath);
  if (!parsed.ok) return parsed;
  const mode = input.mode ?? "full";
  const profile = resolveWorkflowProfile(parsed.data, mode);
  if (!profile.ok) return profile;

  const emit = input.emit ?? (() => undefined);
  const lock = acquireLock(input.lockDir, { owner: `skillwiki-maintenance:${input.hostId}`, now: input.now });
  if (!lock.ok) return lock;

  const checks: JobCheck[] = [];
  const runCommand = input.runCommand ?? createCommandRunner();
  const sessionKind = resolveSessionKind({
    satelliteHostId: input.hostId,
    maintenanceMode: mode,
  });
  const ts = () => new Date().toISOString();
  emit({
    ts: input.now.toISOString(),
    event: "start",
    host_id: input.hostId,
    details: { stage: 2, mode, profile: profile.data.id, sessionKind: sessionKind.data },
  });

  try {
    if (profile.data.runsSelfUpdateApply) {
      const preflight = await runVaultSyncPreflight({ vaultPath: parsed.data.vaultPath, runCommand });
      checks.push(preflight);
      emit({ ts: ts(), event: "job", host_id: input.hostId, job: preflight.job, status: preflight.status, reason: preflight.reason, details: preflight.details });
      if (preflight.status === "fail") {
        emit({ ts: ts(), event: "finish", host_id: input.hostId, status: "fail" });
        return err("MAINTENANCE_FAILED", preflight);
      }

      const selfUpdateApply = await runSelfUpdateApply({ repoPath: parsed.data.repoPath, runCommand });
      checks.push(selfUpdateApply);
      emit({ ts: ts(), event: "job", host_id: input.hostId, job: selfUpdateApply.job, status: selfUpdateApply.status, reason: selfUpdateApply.reason, details: selfUpdateApply.details });
      const failed = checks.find((check) => check.status === "fail");
      emit({ ts: ts(), event: "finish", host_id: input.hostId, status: failed ? "fail" : selfUpdateApply.status });
      if (failed) return err("MAINTENANCE_FAILED", failed);
      return ok({ config: parsed.data, checks });
    }

    if (profile.data.runsSelfUpdateCheck) {
      const selfUpdate = await runSelfUpdateCheck({ repoPath: parsed.data.repoPath, runCommand });
      checks.push(selfUpdate);
      emit({ ts: ts(), event: "job", host_id: input.hostId, job: selfUpdate.job, status: selfUpdate.status, reason: selfUpdate.reason, details: selfUpdate.details });
    }

    if (profile.data.runsPreflight) {
      const preflight = await runVaultSyncPreflight({ vaultPath: parsed.data.vaultPath, runCommand });
      checks.push(preflight);
      emit({ ts: ts(), event: "job", host_id: input.hostId, job: preflight.job, status: preflight.status, reason: preflight.reason, details: preflight.details });
      if (profile.data.id === "unattended-daily" && preflight.status === "fail") {
        emit({ ts: ts(), event: "finish", host_id: input.hostId, status: "fail" });
        return err("MAINTENANCE_FAILED", preflight);
      }
    }

    if (profile.data.id === "self-update-check") {
      const failed = checks.find((check) => check.status === "fail");
      emit({ ts: ts(), event: "finish", host_id: input.hostId, status: failed ? "fail" : "pass" });
      if (failed) return err("MAINTENANCE_FAILED", failed);
      return ok({ config: parsed.data, checks });
    }

    let writeCommitted = false;
    let writeFailed = false;
    for (const job of profile.data.selectedJobs) {
      if (job === "self-update-check" || job === "vault-sync-preflight") continue;
      if (profile.data.writerJobs.includes(job)) {
        if (writeFailed) {
          emit({ ts: ts(), event: "skip", host_id: input.hostId, job, status: "skip", reason: "writing job deferred because a prior writing job failed in this run" });
          continue;
        }
        if (writeCommitted) {
          emit({ ts: ts(), event: "skip", host_id: input.hostId, job, status: "skip", reason: "writing job deferred because a prior writing job already committed in this run" });
          continue;
        }
      }
      if (job === "agent-memory-trends-daily") {
        const trendsStartedAt = input.now.toISOString();
        const trendsDaily = await runAgentMemoryTrendsDaily({
          vaultPath: parsed.data.vaultPath,
          repoPath: parsed.data.repoPath,
          project: "llm-wiki",
          runCommand,
        });
        checks.push(trendsDaily);
        if (trendsDaily.status === "fail") {
          const jobError = trendsDaily.details.jobError;
          writeLatestRunStateOnly(
            parsed.data.vaultPath,
            latestRunFailEntry({
              now: input.now,
              startedAt: trendsStartedAt,
              failureClassCode: jobError?.error ?? "AGENT_MEMORY_TRENDS_DAILY_FAILED",
              heartbeatReason: "writer failed",
            })
          );
        }
        writeFailed = trendsDaily.status === "fail";
        writeCommitted = trendsDaily.details.committed;
        emit({ ts: ts(), event: "job", host_id: input.hostId, job: trendsDaily.job, status: trendsDaily.status, reason: trendsDaily.reason, details: trendsDaily.details });
        if (profile.data.pushAfterCommittedWriter && trendsDaily.status === "pass" && trendsDaily.details.committed) {
          const pushed = await pushVaultChanges(parsed.data.vaultPath, runCommand);
          emit({ ts: ts(), event: "job", host_id: input.hostId, job: "vault-push", status: pushed.ok ? "pass" : "fail", reason: pushed.ok ? "pushed maintenance commit to origin/main" : pushed.detail, details: pushed.ok ? {} : pushed });
          if (!pushed.ok) return err("MAINTENANCE_PUSH_FAILED", pushed);
        }
        continue;
      }
      if (job === "session-brief-refresh") {
        const sessionBrief = await runSessionBriefRefresh({
          vaultPath: parsed.data.vaultPath,
          repoPath: parsed.data.repoPath,
          project: "llm-wiki",
          runCommand,
        });
        checks.push(sessionBrief);
        writeFailed = sessionBrief.status === "fail";
        writeCommitted = sessionBrief.details.committed;
        emit({ ts: ts(), event: "job", host_id: input.hostId, job: sessionBrief.job, status: sessionBrief.status, reason: sessionBrief.reason, details: sessionBrief.details });
        if (profile.data.pushAfterCommittedWriter && sessionBrief.status === "pass" && sessionBrief.details.committed) {
          const pushed = await pushVaultChanges(parsed.data.vaultPath, runCommand);
          emit({ ts: ts(), event: "job", host_id: input.hostId, job: "vault-push", status: pushed.ok ? "pass" : "fail", reason: pushed.ok ? "pushed maintenance commit to origin/main" : pushed.detail, details: pushed.ok ? {} : pushed });
          if (!pushed.ok) return err("MAINTENANCE_PUSH_FAILED", pushed);
        }
        continue;
      }
      if (job === "health-summary") {
        const healthSummary = await runHealthSummary({
          vaultPath: parsed.data.vaultPath,
          repoPath: parsed.data.repoPath,
          runCommand,
        });
        checks.push(healthSummary);
        emit({ ts: ts(), event: "job", host_id: input.hostId, job: healthSummary.job, status: healthSummary.status, reason: healthSummary.reason, details: healthSummary.details });
        continue;
      }
      emit({ ts: ts(), event: "skip", host_id: input.hostId, job, status: "skip", reason: "writing job deferred until dedicated transaction wiring" });
    }

    const failed = checks.find((check) => check.status === "fail");
    emit({ ts: ts(), event: "finish", host_id: input.hostId, status: failed ? "fail" : "pass" });
    if (failed) return err("MAINTENANCE_FAILED", failed);
    return ok({ config: parsed.data, checks });
  } finally {
    await lock.data.release();
  }
}

async function pushVaultChanges(vaultPath: string, runCommand: CommandRunner): Promise<{ ok: true } | { ok: false; detail: string }> {
  const push = await runCommand("git", ["-C", vaultPath, "push", "origin", "main"], { cwd: vaultPath });
  if (push.exitCode === 0) return { ok: true };

  const fetch = await runCommand("git", ["-C", vaultPath, "fetch", "origin", "main"], { cwd: vaultPath });
  if (fetch.exitCode !== 0) {
    return { ok: false, detail: `git push failed (${commandSummary(push)}); fetch before retry failed (${commandSummary(fetch)})` };
  }

  const rebase = await runCommand("git", ["-C", vaultPath, "rebase", "origin/main"], { cwd: vaultPath });
  if (rebase.exitCode !== 0) {
    await runCommand("git", ["-C", vaultPath, "rebase", "--abort"], { cwd: vaultPath });
    return { ok: false, detail: `git push failed (${commandSummary(push)}); rebase before retry failed (${commandSummary(rebase)})` };
  }

  const retry = await runCommand("git", ["-C", vaultPath, "push", "origin", "main"], { cwd: vaultPath });
  if (retry.exitCode === 0) return { ok: true };
  return { ok: false, detail: `git push retry failed: ${commandSummary(retry)}` };
}

export function defaultFleetPath(vaultPath: string): string {
  return join(vaultPath, "projects", "llm-wiki", "architecture", "fleet.yaml");
}

function commandSummary(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr}\n${result.stdout}`;
  const meaningful = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("To "));
  return meaningful ?? "no output";
}

function formatMaintenanceRunDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function formatMaintenanceRunId(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

interface LatestRunFailureEntry {
  runDate: string;
  runId: string;
  status: "fail";
  failureClassCode: string | null;
  startedAt: string;
  finishedAt: string;
  heartbeat: { status: "skipped"; reason: string };
}

function latestRunFailEntry(input: {
  now: Date;
  startedAt?: string;
  failureClassCode: string;
  heartbeatReason: string;
}): LatestRunFailureEntry {
  return {
    runDate: formatMaintenanceRunDate(input.now),
    runId: formatMaintenanceRunId(input.now),
    status: "fail",
    failureClassCode: input.failureClassCode,
    startedAt: input.startedAt ?? input.now.toISOString(),
    finishedAt: new Date().toISOString(),
    heartbeat: { status: "skipped", reason: input.heartbeatReason },
  };
}

/**
 * Write only latest-run.json on maintenance failure paths.
 * Intentionally local (not imported from @skillwiki/agent-memory-trends) so the
 * built maintenance CLI never resolves package export `./src/run-state.js` → `.ts`.
 */
function writeLatestRunStateOnly(vault: string, entry: LatestRunFailureEntry): Result<{ latestRunPath: string }> {
  try {
    const dir = join(vault, ".skillwiki", "agent-memory-trends");
    mkdirSync(dir, { recursive: true });
    const latestRunPath = join(dir, "latest-run.json");
    const body = JSON.stringify(
      {
        run_date: entry.runDate,
        run_id: entry.runId,
        status: entry.status,
        started_at: entry.startedAt,
        finished_at: entry.finishedAt,
        selected_candidate_count: 0,
        task_capture_count: 0,
        changed_files: [],
        failure_class: entry.failureClassCode,
        heartbeat: entry.heartbeat,
      },
      null,
      2
    ) + "\n";
    writeFileSync(latestRunPath, body, "utf8");
    return ok({ latestRunPath });
  } catch (error) {
    return err("RUN_STATE_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }
}
