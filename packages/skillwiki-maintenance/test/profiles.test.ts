import { describe, expect, it } from "vitest";
import type { MaintenanceConfig } from "../src/config.js";
import { APPROVED_JOB_ORDER } from "../src/config.js";
import { resolveWorkflowProfile } from "../src/profiles.js";

function baseConfig(overrides: Partial<MaintenanceConfig> = {}): MaintenanceConfig {
  return {
    sourcePath: "fleet.yaml",
    hostId: "sg02",
    enabled: true,
    user: "agent-memory",
    vaultPath: "/home/agent-memory/wiki",
    repoPath: "/home/agent-memory/llm-wiki",
    sshAlias: "sg02-agent-memory",
    scheduler: "systemd",
    timezone: "Asia/Hong_Kong",
    protectedHost: false,
    jobs: [...APPROVED_JOB_ORDER],
    cadence: {
      selfUpdateCheck: { everyHours: 4 },
      dailyWindow: { time: "00:10", timezone: "Asia/Hong_Kong" },
    },
    ...overrides,
  };
}

describe("resolveWorkflowProfile", () => {
  it("maps current modes to explicit internal profiles and declarative job sets", () => {
    const daily = resolveWorkflowProfile(baseConfig(), "daily");
    expect(daily.ok).toBe(true);
    if (!daily.ok) return;

    expect(daily.data).toMatchObject({
      id: "unattended-daily",
      mode: "daily",
      selectedJobs: ["agent-memory-trends-daily", "health-summary"],
      readOnlyJobs: ["health-summary"],
      writerJobs: ["agent-memory-trends-daily"],
      runsSelfUpdateCheck: false,
      runsPreflight: true,
      runsSelfUpdateApply: false,
      pushAfterCommittedWriter: true,
    });

    const selfUpdate = resolveWorkflowProfile(baseConfig(), "self-update");
    expect(selfUpdate.ok).toBe(true);
    if (!selfUpdate.ok) return;
    expect(selfUpdate.data).toMatchObject({
      id: "self-update-check",
      mode: "self-update",
      selectedJobs: [],
      readOnlyJobs: [],
      writerJobs: [],
      runsSelfUpdateCheck: true,
      runsPreflight: false,
      runsSelfUpdateApply: false,
      pushAfterCommittedWriter: false,
    });

    const sessionBrief = resolveWorkflowProfile(baseConfig(), "session-brief-refresh" as never);
    expect(sessionBrief.ok).toBe(true);
    if (!sessionBrief.ok) return;
    expect(sessionBrief.data).toMatchObject({
      id: "session-brief-refresh",
      mode: "session-brief-refresh",
      selectedJobs: ["session-brief-refresh"],
      readOnlyJobs: [],
      writerJobs: ["session-brief-refresh"],
      runsSelfUpdateCheck: false,
      runsPreflight: true,
      runsSelfUpdateApply: false,
      pushAfterCommittedWriter: true,
    });
  });

  it("fails closed when a protected host is asked to run a mutating profile", () => {
    for (const mode of ["full", "daily", "self-update-apply", "session-brief-refresh"] as const) {
      const resolved = resolveWorkflowProfile(baseConfig({ protectedHost: true }), mode as never);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(String(resolved.detail)).toContain("protected");
      }
    }

    const readOnly = resolveWorkflowProfile(baseConfig({ protectedHost: true }), "self-update");
    expect(readOnly.ok).toBe(true);
    if (!readOnly.ok) return;
    expect(readOnly.data.id).toBe("self-update-check");
  });

  it("fails closed when the selected profile would run writers out of the approved order", () => {
    const resolved = resolveWorkflowProfile(
      baseConfig({
        jobs: [
          "self-update-check",
          "vault-sync-preflight",
          "session-brief-refresh",
          "agent-memory-trends-daily",
          "health-summary",
        ],
      }),
      "full"
    );

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(String(resolved.detail)).toContain("approved Stage 1 job order");
    }
  });
});
