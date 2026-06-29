import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHealthSummary } from "../src/jobs/health-summary.js";
import type { CommandRunResult } from "../src/types.js";

describe("runHealthSummary", () => {
  it("runs skillwiki health as a read-only report and maps info to pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-health-"));
    const repo = join(root, "repo");
    const vault = join(root, "vault");
    mkdirSync(repo, { recursive: true });
    mkdirSync(vault, { recursive: true });
    let outPath = "";
    const calls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];

    const check = await runHealthSummary({
      vaultPath: vault,
      repoPath: repo,
      runCommand: async (command, args, options) => {
        if (command !== "skillwiki") return result("", 127, `unexpected command: ${command}`);
        calls.push({ args, cwd: options.cwd, env: options.env });
        outPath = outputPath(args);
        writeHealthEnvelope(outPath, {
          overall_status: "info",
          advisory_status: "info",
          humanHint: "vault health is informative only",
        });
        return result("");
      },
    });

    expect(check.status).toBe("pass");
    expect(check.reason).toContain("health status info");
    expect(check.details.overallStatus).toBe("info");
    expect(check.details.humanHint).toBe("vault health is informative only");
    expect(check.details.riskFlags).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "health",
      vault,
      "--sync",
      "optional",
      "--no-fail",
      "--out",
      outPath,
    ]);
    expect(calls[0]?.cwd).toBe(repo);
  });

  it("maps warned health reports to maintenance warn and preserves flag summaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-health-warn-"));
    const repo = join(root, "repo");
    const vault = join(root, "vault");
    mkdirSync(repo, { recursive: true });
    mkdirSync(vault, { recursive: true });

    const check = await runHealthSummary({
      vaultPath: vault,
      repoPath: repo,
      runCommand: async (command, args) => {
        if (command !== "skillwiki") return result("", 127, `unexpected command: ${command}`);
        writeHealthEnvelope(outputPath(args), {
          overall_status: "warn",
          advisory_status: "warn",
          risk_flags: [
            { id: "maintenance_backlog", status: "warn", blocking: false },
            { id: "sync_visibility_risk", status: "warn", blocking: false },
          ],
          humanHint: "warning: maintenance backlog detected",
        });
        return result("");
      },
    });

    expect(check.status).toBe("warn");
    expect(check.reason).toContain("health status warn");
    expect(check.reason).toContain("maintenance_backlog");
    expect(check.details.riskFlags.map((flag) => flag.id)).toEqual([
      "maintenance_backlog",
      "sync_visibility_risk",
    ]);
  });

  it("fails when the written health envelope reports an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-health-fail-"));
    const repo = join(root, "repo");
    const vault = join(root, "vault");
    mkdirSync(repo, { recursive: true });
    mkdirSync(vault, { recursive: true });

    const check = await runHealthSummary({
      vaultPath: vault,
      repoPath: repo,
      runCommand: async (command, args) => {
        if (command !== "skillwiki") return result("", 127, `unexpected command: ${command}`);
        writeHealthEnvelope(outputPath(args), {
          overall_status: "error",
          blocking_status: "error",
          risk_flags: [{ id: "content_integrity_risk", status: "error", blocking: true }],
          humanHint: "blocking health error detected",
        });
        return result("");
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("health status error");
    expect(check.details.blockingStatus).toBe("error");
    expect(check.details.riskFlags).toEqual([
      { id: "content_integrity_risk", status: "error", blocking: true },
    ]);
  });
});

function outputPath(args: string[]): string {
  const index = args.indexOf("--out");
  if (index === -1 || !args[index + 1]) throw new Error(`missing --out path in args: ${args.join(" ")}`);
  return args[index + 1]!;
}

function writeHealthEnvelope(
  path: string,
  overrides: Partial<{
    overall_status: "pass" | "info" | "warn" | "error" | "unknown";
    blocking_status: "pass" | "info" | "warn" | "error" | "unknown";
    advisory_status: "pass" | "info" | "warn" | "error" | "unknown";
    risk_flags: Array<{ id: string; status: "pass" | "info" | "warn" | "error" | "unknown"; blocking: boolean }>;
    warnings: Array<{ id: string; message: string }>;
    humanHint: string;
  }> = {}
): void {
  writeFileSync(path, JSON.stringify({
    ok: true,
    data: {
      overall_status: "pass",
      blocking_status: "pass",
      advisory_status: "pass",
      risk_flags: [],
      warnings: [],
      humanHint: "vault health looks good",
      self_check: { status: "pass", errors: [] },
      ...overrides,
    },
  }) + "\n", "utf8");
}

function result(stdout = "", exitCode = 0, stderr = ""): CommandRunResult {
  return { exitCode, stdout, stderr };
}
