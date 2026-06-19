import { describe, expect, it } from "vitest";
import { runSelfUpdateApply, runSelfUpdateCheck } from "../src/jobs/self-update-check.js";
import { runVaultSyncPreflight } from "../src/jobs/vault-sync-preflight.js";
import type { CommandRunner, CommandRunResult } from "../src/types.js";

function result(stdout = "", exitCode = 0, stderr = ""): CommandRunResult {
  return { exitCode, stdout, stderr };
}

function mockRunner(responses: Record<string, CommandRunResult | CommandRunResult[]>): CommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(" ");
    const response = responses[key];
    if (!response) return result("", 127, `unexpected command: ${key}`);
    if (Array.isArray(response)) return response.shift() ?? result("", 127, `unexpected repeated command: ${key}`);
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

describe("runSelfUpdateApply", () => {
  it("passes without mutation when the runner is current", async () => {
    const check = await runSelfUpdateApply({
      repoPath: "/repo",
      runCommand: mockRunner({
        "npm view skillwiki version": result("0.8.10\n"),
        "skillwiki --version": result("0.8.10\n"),
        "git -C /repo status --porcelain --untracked-files=all": result(""),
        "git -C /repo fetch origin main": result(""),
        "git -C /repo rev-parse HEAD": result("aaa111\n"),
        "git -C /repo rev-parse origin/main": result("aaa111\n"),
        "node -p require('./package.json').version": result("0.8.10\n"),
        "node -p require('./packages/agent-memory-trends/package.json').version": result("0.8.10\n"),
      }),
    });

    expect(check.status).toBe("pass");
    expect(check.details.applied).toBe(false);
    expect(check.details.actions.npmInstall.status).toBe("skip");
    expect(check.details.actions.repoFastForward.status).toBe("skip");
  });

  it("applies a stable npm update, fast-forwards the repo, reinstalls wrappers, and verifies convergence", async () => {
    const check = await runSelfUpdateApply({
      repoPath: "/repo",
      runCommand: mockRunner({
        "npm view skillwiki version": [result("0.8.11\n"), result("0.8.11\n")],
        "skillwiki --version": [result("0.8.10\n"), result("0.8.11\n")],
        "git -C /repo status --porcelain --untracked-files=all": [result(""), result("")],
        "git -C /repo fetch origin main": [result(""), result("")],
        "git -C /repo rev-parse HEAD": [result("aaa111\n"), result("bbb222\n")],
        "git -C /repo rev-parse origin/main": [result("bbb222\n"), result("bbb222\n")],
        "git -C /repo merge-base --is-ancestor HEAD origin/main": result(""),
        "node -p require('./package.json').version": [result("0.8.10\n"), result("0.8.11\n")],
        "node -p require('./packages/agent-memory-trends/package.json').version": [result("0.8.10\n"), result("0.8.11\n")],
        "sudo -n true": result(""),
        "npm install -g skillwiki@latest": result("changed 1 package\n"),
        "sudo -n npm install -g skillwiki@latest": result("changed 1 package\n"),
        "git -C /repo merge --ff-only origin/main": result("Updating aaa111..bbb222\n"),
        "sudo -n bash /repo/packages/agent-memory-trends/scripts/install-sg02.sh --enable": result("[agent-memory-trends-install] --enable supplied; enabling timer\n"),
      }),
    });

    expect(check.status).toBe("pass");
    expect(check.details.applied).toBe(true);
    expect(check.details.actions.npmInstall.status).toBe("pass");
    expect(check.details.actions.systemNpmInstall.status).toBe("pass");
    expect(check.details.actions.repoFastForward.status).toBe("pass");
    expect(check.details.actions.wrapperReinstall.status).toBe("pass");
    expect(check.details.after?.repo.status).toBe("current");
  });

  it("fails without applying when the checkout is dirty", async () => {
    const check = await runSelfUpdateApply({
      repoPath: "/repo",
      runCommand: mockRunner({
        "npm view skillwiki version": result("0.8.11\n"),
        "skillwiki --version": result("0.8.10\n"),
        "git -C /repo status --porcelain --untracked-files=all": result(" M package.json\n"),
        "node -p require('./package.json').version": result("0.8.10\n"),
        "node -p require('./packages/agent-memory-trends/package.json').version": result("0.8.10\n"),
      }),
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("blocked");
    expect(check.details.applied).toBe(false);
  });
});
