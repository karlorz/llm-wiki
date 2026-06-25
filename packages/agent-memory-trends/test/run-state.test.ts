import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAILURE_CLASSES,
  writeRunState,
  type AgentMemoryTrendRunState,
} from "../src/run-state.js";
import { maybeSendHeartbeat, type HeartbeatFetch } from "../src/heartbeat.js";

function runState(overrides: Partial<AgentMemoryTrendRunState> = {}): AgentMemoryTrendRunState {
  return {
    runDate: "2026-06-11",
    runId: "2026-06-11T00-10-00+08-00",
    status: "success",
    startedAt: "2026-06-11T00:10:00+08:00",
    finishedAt: "2026-06-11T00:14:00+08:00",
    selectedCandidateCount: 3,
    taskCaptureCount: 1,
    changedFiles: [
      "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      "queries/2026-06-11-agent-memory-trends-digest.md",
    ],
    failureClass: null,
    heartbeat: {
      status: "skipped",
      reason: "heartbeat disabled",
    },
    ...overrides,
  };
}

describe("agent-memory-trends run state and heartbeat", () => {
  it("writes dated run JSON and latest-run JSON with stable snake_case fields", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-state-"));
    const result = writeRunState(vault, runState());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected state write");
    expect(result.data.runStatePath).toBe(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-11-run.json"));
    expect(result.data.latestRunPath).toBe(join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json"));
    expect(existsSync(result.data.runStatePath)).toBe(true);
    expect(existsSync(result.data.latestRunPath)).toBe(true);

    const dated = JSON.parse(readFileSync(result.data.runStatePath, "utf8"));
    const latest = JSON.parse(readFileSync(result.data.latestRunPath, "utf8"));
    expect(dated).toEqual(latest);
    expect(dated).toMatchObject({
      run_date: "2026-06-11",
      run_id: "2026-06-11T00-10-00+08-00",
      status: "success",
      selected_candidate_count: 3,
      task_capture_count: 1,
      failure_class: null,
      heartbeat: {
        status: "skipped",
        reason: "heartbeat disabled",
      },
    });
  });

  it("records the required failure classes for service diagnostics", () => {
    expect(FAILURE_CLASSES).toEqual([
      "collector",
      "agent",
      "allowlist",
      "validation",
      "dirty_preflight",
      "conflict",
      "push",
      "heartbeat",
    ]);

    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-state-"));
    const result = writeRunState(
      vault,
      runState({
        status: "failure",
        failureClass: "push",
        heartbeat: {
          status: "skipped",
          reason: "push failed",
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected failure state write");
    const body = JSON.parse(readFileSync(result.data.runStatePath, "utf8"));
    expect(body.failure_class).toBe("push");
  });

  it("writes synthesis backend telemetry when synthesis was invoked", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-state-"));
    const result = writeRunState(
      vault,
      runState({
        synthesis: {
          invoked: true,
          primaryBackend: "codex",
          primaryAttempts: 2,
          primaryFailed: true,
          fallbackBackend: "claude",
          fallbackAvailable: true,
          fallbackInvoked: true,
          resultBackend: "claude",
          failureCode: null,
          primaryErrorCode: "CODEX_RUN_FAILED",
          fallbackErrorCode: null,
        },
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected state write");
    const body = JSON.parse(readFileSync(result.data.runStatePath, "utf8"));
    expect(body.synthesis).toEqual({
      invoked: true,
      primary_backend: "codex",
      primary_attempts: 2,
      primary_failed: true,
      fallback_backend: "claude",
      fallback_available: true,
      fallback_invoked: true,
      result_backend: "claude",
      failure_code: null,
      primary_error_code: "CODEX_RUN_FAILED",
      fallback_error_code: null,
    });
  });

  it("skips heartbeat when disabled, URL is missing, or push has not succeeded", async () => {
    const fetchCalls: string[] = [];
    const fetchFn: HeartbeatFetch = async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 200, text: async () => "ok" };
    };

    await expect(maybeSendHeartbeat({ enabled: false, url: "https://kuma.example/push", pushSucceeded: true, fetchFn })).resolves.toEqual({
      ok: true,
      data: { status: "skipped", reason: "heartbeat disabled" },
    });
    await expect(maybeSendHeartbeat({ enabled: true, url: undefined, pushSucceeded: true, fetchFn })).resolves.toEqual({
      ok: true,
      data: { status: "skipped", reason: "heartbeat URL missing" },
    });
    await expect(maybeSendHeartbeat({ enabled: true, url: "https://kuma.example/push", pushSucceeded: false, fetchFn })).resolves.toEqual({
      ok: true,
      data: { status: "skipped", reason: "push did not succeed" },
    });
    expect(fetchCalls).toEqual([]);
  });

  it("pings heartbeat only after successful push and fails the service when enabled heartbeat fails", async () => {
    const urls: string[] = [];
    const okFetch: HeartbeatFetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "OK" };
    };

    const sent = await maybeSendHeartbeat({
      enabled: true,
      url: "https://kuma.example/api/push/agent-memory",
      pushSucceeded: true,
      fetchFn: okFetch,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error("expected heartbeat success");
    expect(sent.data).toEqual({ status: "sent", url: "https://kuma.example/api/push/agent-memory" });
    expect(urls).toEqual(["https://kuma.example/api/push/agent-memory"]);

    const failed = await maybeSendHeartbeat({
      enabled: true,
      url: "https://kuma.example/api/push/agent-memory",
      pushSucceeded: true,
      fetchFn: async () => ({ ok: false, status: 500, text: async () => "nope" }),
    });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected heartbeat failure");
    expect(failed.error).toBe("HEARTBEAT_FAILED");
    expect(failed.detail).toMatchObject({ status: 500, body: "nope" });
  });
});
