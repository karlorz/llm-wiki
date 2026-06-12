import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCommandRunner } from "./command.js";
import { parseMaintenanceConfig, type MaintenanceConfig } from "./config.js";
import { runAgentMemoryTrendsDaily } from "./jobs/agent-memory-trends-daily.js";
import { runSelfUpdateCheck } from "./jobs/self-update-check.js";
import { runSessionBriefRefresh } from "./jobs/session-brief-refresh.js";
import { runVaultSyncPreflight } from "./jobs/vault-sync-preflight.js";
import { acquireLock } from "./lock.js";
import { err, ok, type CommandRunner, type JobCheck, type Result } from "./types.js";

export interface RunMaintenanceInput {
  fleetPath: string;
  hostId: string;
  lockDir: string;
  now: Date;
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

  const emit = input.emit ?? (() => undefined);
  const lock = acquireLock(input.lockDir, { owner: `skillwiki-maintenance:${input.hostId}`, now: input.now });
  if (!lock.ok) return lock;

  const checks: JobCheck[] = [];
  const runCommand = input.runCommand ?? createCommandRunner();
  const ts = () => new Date().toISOString();
  emit({ ts: input.now.toISOString(), event: "start", host_id: input.hostId, details: { stage: 2 } });

  try {
    const selfUpdate = await runSelfUpdateCheck({ repoPath: parsed.data.repoPath, runCommand });
    checks.push(selfUpdate);
    emit({ ts: ts(), event: "job", host_id: input.hostId, job: selfUpdate.job, status: selfUpdate.status, reason: selfUpdate.reason, details: selfUpdate.details });

    const preflight = await runVaultSyncPreflight({ vaultPath: parsed.data.vaultPath, runCommand });
    checks.push(preflight);
    emit({ ts: ts(), event: "job", host_id: input.hostId, job: preflight.job, status: preflight.status, reason: preflight.reason, details: preflight.details });

    let writeCommitted = false;
    for (const job of parsed.data.jobs) {
      if (job === "self-update-check" || job === "vault-sync-preflight") continue;
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
        writeCommitted = trendsDaily.details.committed;
        emit({ ts: ts(), event: "job", host_id: input.hostId, job: trendsDaily.job, status: trendsDaily.status, reason: trendsDaily.reason, details: trendsDaily.details });
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

export function defaultFleetPath(vaultPath: string): string {
  return join(vaultPath, "projects", "llm-wiki", "architecture", "fleet.yaml");
}
