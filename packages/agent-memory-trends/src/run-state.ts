import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SynthesisTelemetry } from "./synthesis.js";
import { err, ok, type Result } from "./types.js";

export const FAILURE_CLASSES = [
  "collector",
  "agent",
  "allowlist",
  "validation",
  "dirty_preflight",
  "conflict",
  "push",
  "heartbeat",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type RunStatus = "success" | "failure" | "fail";

export type HeartbeatState =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "sent";
      url: string;
    }
  | {
      status: "failed";
      url: string;
      statusCode?: number;
      body?: string;
    };

export interface DedupeParseErrorWire {
  path: string;
  error: string;
}

export interface AgentMemoryTrendRunState {
  runDate: string;
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  selectedCandidateCount: number;
  taskCaptureCount: number;
  changedFiles: string[];
  failureClass: FailureClass | null;
  heartbeat: HeartbeatState;
  synthesis?: SynthesisTelemetry;
  dedupeParseErrors?: DedupeParseErrorWire[];
}

export interface WriteRunStateOutput {
  runStatePath: string;
  latestRunPath: string;
}

export function writeRunState(vault: string, state: AgentMemoryTrendRunState): Result<WriteRunStateOutput> {
  const invalidFailureClass =
    state.failureClass !== null && !FAILURE_CLASSES.includes(state.failureClass);
  if (invalidFailureClass) return err("RUN_STATE_INVALID", `unknown failure class: ${state.failureClass}`);

  try {
    const dir = join(vault, ".skillwiki", "agent-memory-trends");
    mkdirSync(dir, { recursive: true });
    const runStatePath = join(dir, `${state.runDate}-run.json`);
    const latestRunPath = join(dir, "latest-run.json");
    const body = JSON.stringify(toWireRunState(state), null, 2) + "\n";
    writeFileSync(runStatePath, body, "utf8");
    writeFileSync(latestRunPath, body, "utf8");
    return ok({ runStatePath, latestRunPath });
  } catch (error) {
    return err("RUN_STATE_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function toWireRunState(state: AgentMemoryTrendRunState): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    run_date: state.runDate,
    run_id: state.runId,
    status: state.status,
    started_at: state.startedAt,
    finished_at: state.finishedAt,
    selected_candidate_count: state.selectedCandidateCount,
    task_capture_count: state.taskCaptureCount,
    changed_files: state.changedFiles,
    failure_class: state.failureClass,
    heartbeat: toWireHeartbeat(state.heartbeat),
  };
  if (state.synthesis) wire.synthesis = synthesisTelemetryToWire(state.synthesis);
  if (state.dedupeParseErrors && state.dedupeParseErrors.length > 0) {
    wire.dedupe_parse_errors = state.dedupeParseErrors;
  }
  return wire;
}

/** Writes latest-run.json for maintenance failure paths (no dated run file, no commit). */
export function writeLatestRunStateOnly(
  vault: string,
  entry: {
    runDate: string;
    runId: string;
    status: RunStatus;
    failureClassCode: string | null;
    startedAt: string;
    finishedAt: string;
    heartbeat: HeartbeatState;
  }
): Result<{ latestRunPath: string }> {
  try {
    const dir = join(vault, ".skillwiki", "agent-memory-trends");
    mkdirSync(dir, { recursive: true });
    const latestRunPath = join(dir, "latest-run.json");
    const body =
      JSON.stringify(
        {
          run_date: entry.runDate,
          run_id: entry.runId,
          status: entry.status,
          started_at: entry.startedAt,
          finished_at: entry.finishedAt,
          selected_candidate_count: 0,
          task_capture_count: 0,
          changed_files: [] as string[],
          failure_class: entry.failureClassCode,
          heartbeat: toWireHeartbeat(entry.heartbeat),
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

export function synthesisTelemetryToWire(synthesis: SynthesisTelemetry): Record<string, unknown> {
  return {
    invoked: synthesis.invoked,
    primary_backend: synthesis.primaryBackend,
    primary_attempts: synthesis.primaryAttempts,
    primary_failed: synthesis.primaryFailed,
    fallback_backend: synthesis.fallbackBackend,
    fallback_available: synthesis.fallbackAvailable,
    fallback_invoked: synthesis.fallbackInvoked,
    result_backend: synthesis.resultBackend,
    failure_code: synthesis.failureCode,
    primary_error_code: synthesis.primaryErrorCode,
    fallback_error_code: synthesis.fallbackErrorCode,
  };
}

function toWireHeartbeat(heartbeat: HeartbeatState): Record<string, unknown> {
  if (heartbeat.status === "failed") {
    return {
      status: heartbeat.status,
      url: heartbeat.url,
      status_code: heartbeat.statusCode,
      body: heartbeat.body,
    };
  }
  return { ...heartbeat };
}
