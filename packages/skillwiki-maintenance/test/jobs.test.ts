import { describe, expect, it } from "vitest";
import { runSelfUpdateCheck } from "../src/jobs/self-update-check.js";
import { runVaultSyncPreflight } from "../src/jobs/vault-sync-preflight.js";
import type { CommandRunner, CommandRunResult } from "../src/types.js";

function result(stdout = "", exitCode = 0, stderr = ""): CommandRunResult {
  return { exitCode, stdout, stderr };
}

function mockRunner(responses: Record<string, CommandRunResult>): CommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(" ");
    const response = responses[key];
    if (!response) return result("", 127, `unexpected command: ${key}`);
    return response;
  };
}

describe("runVaultSyncPreflight", () => {
  it("refuses a dirty vault before fetch or push checks", async () => {
    const runCommand = mockRunner({
      "git -C /vault status --porcelain --untracked-files=all": result(" M meta/latest-session-brief.md\n"),
    });

    const check = await runVaultSyncPreflight({ vaultPath: "/vault", runCommand });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("dirty");
    expect(check.details.changedFiles).toEqual(["meta/latest-session-brief.md"]);
  });

  it("detects behind and ahead vault states", async () => {
    const behind = await runVaultSyncPreflight({
      vaultPath: "/vault",
      runCommand: mockRunner({
        "git -C /vault status --porcelain --untracked-files=all": result(""),
        "git -C /vault fetch origin main": result(""),
        "git -C /vault rev-list --left-right --count HEAD...origin/main": result("0\t2\n"),
      }),
    });

    expect(behind.status).toBe("fail");
    expect(behind.details.ahead).toBe(0);
    expect(behind.details.behind).toBe(2);

    const ahead = await runVaultSyncPreflight({
      vaultPath: "/vault",
      runCommand: mockRunner({
        "git -C /vault status --porcelain --untracked-files=all": result(""),
        "git -C /vault fetch origin main": result(""),
        "git -C /vault rev-list --left-right --count HEAD...origin/main": result("1\t0\n"),
      }),
    });

    expect(ahead.status).toBe("fail");
    expect(ahead.details.ahead).toBe(1);
    expect(ahead.details.behind).toBe(0);
  });

  it("passes only when the vault is clean, synchronized, and pushable", async () => {
    const check = await runVaultSyncPreflight({
      vaultPath: "/vault",
      runCommand: mockRunner({
        "git -C /vault status --porcelain --untracked-files=all": result(""),
        "git -C /vault fetch origin main": result(""),
        "git -C /vault rev-list --left-right --count HEAD...origin/main": result("0\t0\n"),
        "git -C /vault push --dry-run origin main": result("To github.com:karlorz/wiki.git\n"),
      }),
    });

    expect(check.status).toBe("pass");
    expect(check.reason).toContain("clean");
  });
});

describe("runSelfUpdateCheck", () => {
  it("reports fast-forward update eligibility without applying changes", async () => {
    const check = await runSelfUpdateCheck({
      repoPath: "/repo",
      runCommand: mockRunner({
        "npm view skillwiki version": result("0.8.11\n"),
        "skillwiki --version": result("0.8.10\n"),
        "git -C /repo status --porcelain --untracked-files=all": result(""),
        "git -C /repo fetch origin main": result(""),
        "git -C /repo rev-parse HEAD": result("aaa111\n"),
        "git -C /repo rev-parse origin/main": result("bbb222\n"),
        "git -C /repo merge-base --is-ancestor HEAD origin/main": result(""),
        "node -p require('./package.json').version": result("0.8.10\n"),
        "node -p require('./packages/agent-memory-trends/package.json').version": result("0.8.10\n"),
      }),
    });

    expect(check.status).toBe("warn");
    expect(check.details.npm.updateAvailable).toBe(true);
    expect(check.details.repo.status).toBe("fast-forward-available");
    expect(check.details.applyEligible).toBe(true);
  });
});
