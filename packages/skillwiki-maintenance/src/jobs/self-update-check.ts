import { join } from "node:path";
import type { CommandRunner, JobCheck } from "../types.js";

export interface SelfUpdateCheckInput {
  repoPath: string;
  runCommand: CommandRunner;
}

export interface SelfUpdateCheckDetails {
  npm: {
    current: string;
    latest: string;
    updateAvailable: boolean;
    stableLatest: boolean;
  };
  repo: {
    status: "current" | "fast-forward-available" | "dirty" | "diverged" | "unknown";
    head?: string;
    originMain?: string;
  };
  packages: {
    root?: string;
    agentMemoryTrends?: string;
  };
  applyEligible: boolean;
}

export interface SelfUpdateApplyDetails {
  before: SelfUpdateCheckDetails;
  after?: SelfUpdateCheckDetails;
  actions: {
    npmInstall: SelfUpdateAction;
    systemNpmInstall: SelfUpdateAction;
    repoFastForward: SelfUpdateAction;
    wrapperReinstall: SelfUpdateAction;
  };
  applied: boolean;
}

export interface SelfUpdateAction {
  status: "pass" | "skip" | "fail";
  reason: string;
  command?: string;
  exitCode?: number;
  output?: string;
}

export async function runSelfUpdateCheck(input: SelfUpdateCheckInput): Promise<JobCheck<SelfUpdateCheckDetails>> {
  const npmLatest = await input.runCommand("npm", ["view", "skillwiki", "version"], { cwd: input.repoPath });
  const currentCli = await input.runCommand("skillwiki", ["--version"], { cwd: input.repoPath });
  const rootVersion = await input.runCommand("node", ["-p", "require('./package.json').version"], { cwd: input.repoPath });
  const runnerVersion = await input.runCommand("node", ["-p", "require('./packages/agent-memory-trends/package.json').version"], {
    cwd: input.repoPath,
  });

  const current = currentCli.stdout.trim();
  const latest = npmLatest.stdout.trim();
  const stableLatest = latest.length > 0 && !latest.includes("-");
  const npmUpdateAvailable = stableLatest && compareVersions(latest, current) > 0;

  const repo = await checkRepo(input);
  const details: SelfUpdateCheckDetails = {
    npm: {
      current,
      latest,
      updateAvailable: npmUpdateAvailable,
      stableLatest,
    },
    repo,
    packages: {
      root: rootVersion.exitCode === 0 ? rootVersion.stdout.trim() : undefined,
      agentMemoryTrends: runnerVersion.exitCode === 0 ? runnerVersion.stdout.trim() : undefined,
    },
    applyEligible: (npmUpdateAvailable || repo.status === "fast-forward-available") && (repo.status === "current" || repo.status === "fast-forward-available"),
  };

  if ([npmLatest, currentCli, rootVersion, runnerVersion].some((result) => result.exitCode !== 0) || repo.status === "unknown") {
    return { job: "self-update-check", status: "fail", reason: "self-update check could not read required version state", details };
  }

  if (repo.status === "dirty" || repo.status === "diverged") {
    return { job: "self-update-check", status: "fail", reason: `repo update is blocked: ${repo.status}`, details };
  }

  if (details.applyEligible || npmUpdateAvailable || repo.status === "fast-forward-available") {
    return { job: "self-update-check", status: "warn", reason: "stable update or repo fast-forward is available and eligible for conservative apply", details };
  }

  return { job: "self-update-check", status: "pass", reason: "runner and npm CLI are current", details };
}

export async function runSelfUpdateApply(input: SelfUpdateCheckInput): Promise<JobCheck<SelfUpdateApplyDetails>> {
  const before = await runSelfUpdateCheck(input);
  const details: SelfUpdateApplyDetails = {
    before: before.details,
    actions: {
      npmInstall: skipped("npm CLI is already current"),
      systemNpmInstall: skipped("system npm CLI refresh not needed"),
      repoFastForward: skipped("repo checkout is already current"),
      wrapperReinstall: skipped("wrapper reinstall not needed"),
    },
    applied: false,
  };

  if (before.status === "fail") {
    return { job: "self-update-apply", status: "fail", reason: `self-update apply blocked: ${before.reason}`, details };
  }

  if (!before.details.applyEligible) {
    return { job: "self-update-apply", status: "pass", reason: "runner and npm CLI are already current", details };
  }

  if (before.details.npm.updateAvailable) {
    details.actions.npmInstall = await runAction(input, "npm", ["install", "-g", "skillwiki@latest"]);
    if (details.actions.npmInstall.status === "fail") {
      return { job: "self-update-apply", status: "fail", reason: "failed to install latest npm CLI for service user", details };
    }
    details.applied = true;
  }

  const sudoAvailable = await hasPasswordlessSudo(input);
  if (before.details.npm.updateAvailable && sudoAvailable) {
    details.actions.systemNpmInstall = await runAction(input, "sudo", ["-n", "npm", "install", "-g", "skillwiki@latest"]);
    if (details.actions.systemNpmInstall.status === "fail") {
      return { job: "self-update-apply", status: "fail", reason: "failed to install latest npm CLI for system path", details };
    }
  } else if (before.details.npm.updateAvailable) {
    details.actions.systemNpmInstall = skipped("passwordless sudo is unavailable");
  }

  if (before.details.repo.status === "fast-forward-available") {
    details.actions.repoFastForward = await runAction(input, "git", ["-C", input.repoPath, "merge", "--ff-only", "origin/main"]);
    if (details.actions.repoFastForward.status === "fail") {
      return { job: "self-update-apply", status: "fail", reason: "failed to fast-forward repo checkout", details };
    }
    details.applied = true;
  }

  if (details.applied && sudoAvailable) {
    details.actions.wrapperReinstall = await runAction(input, "sudo", ["-n", "bash", join(input.repoPath, "packages", "agent-memory-trends", "scripts", "install-sg02.sh"), "--enable"]);
    if (details.actions.wrapperReinstall.status === "fail") {
      return { job: "self-update-apply", status: "fail", reason: "failed to reinstall sg02 maintenance wrapper", details };
    }
  } else if (details.applied) {
    details.actions.wrapperReinstall = skipped("passwordless sudo is unavailable");
  }

  const after = await runSelfUpdateCheck(input);
  details.after = after.details;
  if (after.status !== "pass") {
    return { job: "self-update-apply", status: "fail", reason: `post-apply self-update check did not converge: ${after.reason}`, details };
  }

  const wrapperSkipped = details.applied && details.actions.wrapperReinstall.status === "skip";
  return {
    job: "self-update-apply",
    status: wrapperSkipped ? "warn" : "pass",
    reason: wrapperSkipped ? "updated runner, but wrapper reinstall requires manual root refresh" : "stable update applied and verified",
    details,
  };
}

async function checkRepo(input: SelfUpdateCheckInput): Promise<SelfUpdateCheckDetails["repo"]> {
  const status = await input.runCommand("git", ["-C", input.repoPath, "status", "--porcelain", "--untracked-files=all"], {
    cwd: input.repoPath,
  });
  if (status.exitCode !== 0) return { status: "unknown" };
  if (status.stdout.trim()) return { status: "dirty" };

  const fetch = await input.runCommand("git", ["-C", input.repoPath, "fetch", "origin", "main"], { cwd: input.repoPath });
  if (fetch.exitCode !== 0) return { status: "unknown" };

  const head = await input.runCommand("git", ["-C", input.repoPath, "rev-parse", "HEAD"], { cwd: input.repoPath });
  const originMain = await input.runCommand("git", ["-C", input.repoPath, "rev-parse", "origin/main"], { cwd: input.repoPath });
  if (head.exitCode !== 0 || originMain.exitCode !== 0) return { status: "unknown" };

  const headSha = head.stdout.trim();
  const originSha = originMain.stdout.trim();
  if (headSha === originSha) return { status: "current", head: headSha, originMain: originSha };

  const ancestor = await input.runCommand("git", ["-C", input.repoPath, "merge-base", "--is-ancestor", "HEAD", "origin/main"], {
    cwd: input.repoPath,
  });
  return {
    status: ancestor.exitCode === 0 ? "fast-forward-available" : "diverged",
    head: headSha,
    originMain: originSha,
  };
}

async function hasPasswordlessSudo(input: SelfUpdateCheckInput): Promise<boolean> {
  const result = await input.runCommand("sudo", ["-n", "true"], { cwd: input.repoPath });
  return result.exitCode === 0;
}

async function runAction(input: SelfUpdateCheckInput, command: string, args: string[]): Promise<SelfUpdateAction> {
  const result = await input.runCommand(command, args, { cwd: input.repoPath });
  const output = firstLine(result.stderr || result.stdout);
  if (result.exitCode === 0) {
    return {
      status: "pass",
      reason: output || "command succeeded",
      command: [command, ...args].join(" "),
      exitCode: result.exitCode,
      output,
    };
  }
  return {
    status: "fail",
    reason: output || "command failed",
    command: [command, ...args].join(" "),
    exitCode: result.exitCode,
    output,
  };
}

function skipped(reason: string): SelfUpdateAction {
  return { status: "skip", reason };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] || "";
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseVersion(value: string): number[] {
  return value.replace(/^v/, "").split("-", 1)[0]!.split(".").map((part) => Number(part) || 0);
}
