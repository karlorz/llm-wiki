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
    applyEligible: npmUpdateAvailable && repo.status === "fast-forward-available",
  };

  if ([npmLatest, currentCli, rootVersion, runnerVersion].some((result) => result.exitCode !== 0) || repo.status === "unknown") {
    return { job: "self-update-check", status: "fail", reason: "self-update check could not read required version state", details };
  }

  if (repo.status === "dirty" || repo.status === "diverged") {
    return { job: "self-update-check", status: "fail", reason: `repo update is blocked: ${repo.status}`, details };
  }

  if (details.applyEligible || npmUpdateAvailable || repo.status === "fast-forward-available") {
    return { job: "self-update-check", status: "warn", reason: "stable update is available and eligible for conservative apply", details };
  }

  return { job: "self-update-check", status: "pass", reason: "runner and npm CLI are current", details };
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
