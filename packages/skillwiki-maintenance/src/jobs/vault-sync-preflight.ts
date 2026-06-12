import type { CommandRunner, JobCheck } from "../types.js";

export interface VaultSyncPreflightInput {
  vaultPath: string;
  runCommand: CommandRunner;
}

export interface VaultSyncPreflightDetails {
  changedFiles: string[];
  ahead?: number;
  behind?: number;
}

export async function runVaultSyncPreflight(input: VaultSyncPreflightInput): Promise<JobCheck<VaultSyncPreflightDetails>> {
  const status = await input.runCommand("git", ["-C", input.vaultPath, "status", "--porcelain", "--untracked-files=all"], {
    cwd: input.vaultPath,
  });
  if (status.exitCode !== 0) {
    return fail("git status failed", { changedFiles: [] });
  }

  const changedFiles = filesFromPorcelain(status.stdout);
  if (changedFiles.length > 0) {
    return fail(`vault is dirty: ${changedFiles[0]}`, { changedFiles });
  }

  const fetch = await input.runCommand("git", ["-C", input.vaultPath, "fetch", "origin", "main"], { cwd: input.vaultPath });
  if (fetch.exitCode !== 0) {
    return fail(`git fetch failed: ${firstLine(fetch.stderr || fetch.stdout)}`, { changedFiles });
  }

  const counts = await input.runCommand("git", ["-C", input.vaultPath, "rev-list", "--left-right", "--count", "HEAD...origin/main"], {
    cwd: input.vaultPath,
  });
  if (counts.exitCode !== 0) {
    return fail(`git ahead/behind check failed: ${firstLine(counts.stderr || counts.stdout)}`, { changedFiles });
  }

  const [ahead, behind] = parseAheadBehind(counts.stdout);
  if (ahead > 0 || behind > 0) {
    return fail(`vault is not synchronized with origin/main (ahead ${ahead}, behind ${behind})`, { changedFiles, ahead, behind });
  }

  const push = await input.runCommand("git", ["-C", input.vaultPath, "push", "--dry-run", "origin", "main"], { cwd: input.vaultPath });
  if (push.exitCode !== 0) {
    return fail(`push dry-run failed: ${firstLine(push.stderr || push.stdout)}`, { changedFiles, ahead, behind });
  }

  return {
    job: "vault-sync-preflight",
    status: "pass",
    reason: "vault is clean, synchronized, and pushable",
    details: { changedFiles, ahead, behind },
  };
}

function fail(reason: string, details: VaultSyncPreflightDetails): JobCheck<VaultSyncPreflightDetails> {
  return { job: "vault-sync-preflight", status: "fail", reason, details };
}

function filesFromPorcelain(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const path = line.slice(3).trim();
    const renameSeparator = " -> ";
    return path.includes(renameSeparator) ? path.slice(path.lastIndexOf(renameSeparator) + renameSeparator.length) : path;
  });
}

function parseAheadBehind(stdout: string): [number, number] {
  const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/, 2);
  return [Number(aheadRaw || 0), Number(behindRaw || 0)];
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] || "no output";
}
