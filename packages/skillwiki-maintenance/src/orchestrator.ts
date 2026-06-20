import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSessionKind } from "@skillwiki/shared";
import { createCommandRunner } from "./command.js";
import { parseMaintenanceConfig, type MaintenanceConfig } from "./config.js";
import { runAgentMemoryTrendsDaily } from "./jobs/agent-memory-trends-daily.js";
import { runSelfUpdateApply, runSelfUpdateCheck } from "./jobs/self-update-check.js";
import { runSessionBriefRefresh } from "./jobs/session-brief-refresh.js";
import { runVaultSyncPreflight } from "./jobs/vault-sync-preflight.js";
import { acquireLock } from "./lock.js";
import { err, ok, type CommandRunner, type JobCheck, type Result } from "./types.js";

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

export type MaintenanceMode = "full" | "daily" | "self-update" | "self-update-apply";

export async function runStage1Maintenance(input: RunMaintenanceInput): Promise<Result<RunMaintenanceOutput>> {
  const parsed = parseMaintenanceConfig(readFileSync(input.fleetPath, "utf8"), input.hostId, input.fleetPath);
  if (!parsed.ok) return parsed;
  const mode = input.mode ?? "full";
  if (!["full", "daily", "self-update", "self-update-apply"].includes(mode)) return err("CONFIG_INVALID", `unsupported maintenance mode: ${mode}`);

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
    details: { stage: 2, mode, sessionKind: sessionKind.data },
  });

  try {
    if (mode === "self-update-apply") {
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

    if (mode !== "daily") {
      const selfUpdate = await runSelfUpdateCheck({ repoPath: parsed.data.repoPath, runCommand });
      checks.push(selfUpdate);
      emit({ ts: ts(), event: "job", host_id: input.hostId, job: selfUpdate.job, status: selfUpdate.status, reason: selfUpdate.reason, details: selfUpdate.details });
    }

    if (mode !== "self-update") {
      const preflight = await runVaultSyncPreflight({ vaultPath: parsed.data.vaultPath, runCommand });
      checks.push(preflight);
      emit({ ts: ts(), event: "job", host_id: input.hostId, job: preflight.job, status: preflight.status, reason: preflight.reason, details: preflight.details });
      if (mode === "daily" && preflight.status === "fail") {
        emit({ ts: ts(), event: "finish", host_id: input.hostId, status: "fail" });
        return err("MAINTENANCE_FAILED", preflight);
      }
    }

    if (mode === "self-update") {
      const failed = checks.find((check) => check.status === "fail");
      emit({ ts: ts(), event: "finish", host_id: input.hostId, status: failed ? "fail" : "pass" });
      if (failed) return err("MAINTENANCE_FAILED", failed);
      return ok({ config: parsed.data, checks });
    }

    let writeCommitted = false;
    let writeFailed = false;
    const jobs = mode === "daily" ? (["agent-memory-trends-daily"] as const) : parsed.data.jobs;
    for (const job of jobs) {
      if (job === "self-update-check" || job === "vault-sync-preflight") continue;
      if (writeFailed) {
        emit({ ts: ts(), event: "skip", host_id: input.hostId, job, status: "skip", reason: "writing job deferred because a prior writing job failed in this run" });
        continue;
      }
      if (writeCommitted) {
        emit({ ts: ts(), event: "skip", host_id: input.hostId, job, status: "skip", reason: "writing job deferred because a prior writing job already committed in this run" });
        continue;
      }
      if (job === "agent-memory-trends-daily") {
        const trendsDaily = await runAgentMemoryTrendsDaily({
          vaultPath: parsed.data.vaultPath,
          repoPath: parsed.data.repoPath,
          project: "llm-wiki",
          runCommand,
        });
        checks.push(trendsDaily);
        writeFailed = trendsDaily.status === "fail";
        writeCommitted = trendsDaily.details.committed;
        emit({ ts: ts(), event: "job", host_id: input.hostId, job: trendsDaily.job, status: trendsDaily.status, reason: trendsDaily.reason, details: trendsDaily.details });
        if (mode === "daily" && trendsDaily.status === "pass" && trendsDaily.details.committed) {
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
