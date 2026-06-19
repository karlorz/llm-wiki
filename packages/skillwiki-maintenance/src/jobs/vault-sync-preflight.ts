import type { CommandRunner, JobCheck } from "../types.js";

export interface VaultSyncPreflightInput {
  vaultPath: string;
  runCommand: CommandRunner;
}

export interface VaultSyncPreflightDetails {
  changedFiles: string[];
  ahead?: number;
  behind?: number;
  originalAhead?: number;
  originalBehind?: number;
  fastForwarded?: boolean;
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

  const [originalAhead, originalBehind] = parseAheadBehind(counts.stdout);
  let ahead = originalAhead;
  let behind = originalBehind;
  let fastForwarded = false;
  const details = (files = changedFiles): VaultSyncPreflightDetails => ({
    changedFiles: files,
    ahead,
    behind,
    originalAhead,
    originalBehind,
    fastForwarded,
  });

  if (ahead > 0) {
    return fail(`vault is not synchronized with origin/main (ahead ${ahead}, behind ${behind})`, details());
  }

  if (behind > 0) {
    const merge = await input.runCommand("git", ["-C", input.vaultPath, "merge", "--ff-only", "origin/main"], { cwd: input.vaultPath });
    if (merge.exitCode !== 0) {
      return fail(`git fast-forward failed: ${firstLine(merge.stderr || merge.stdout)}`, details());
    }
    fastForwarded = true;

    const statusAfterMerge = await input.runCommand("git", ["-C", input.vaultPath, "status", "--porcelain", "--untracked-files=all"], {
      cwd: input.vaultPath,
    });
    if (statusAfterMerge.exitCode !== 0) {
      return fail("git status after fast-forward failed", details());
    }

    const changedAfterMerge = filesFromPorcelain(statusAfterMerge.stdout);
    if (changedAfterMerge.length > 0) {
      return fail(`vault is dirty after fast-forward: ${changedAfterMerge[0]}`, details(changedAfterMerge));
    }

    const countsAfterMerge = await input.runCommand("git", ["-C", input.vaultPath, "rev-list", "--left-right", "--count", "HEAD...origin/main"], {
      cwd: input.vaultPath,
    });
    if (countsAfterMerge.exitCode !== 0) {
      return fail(`git ahead/behind check after fast-forward failed: ${firstLine(countsAfterMerge.stderr || countsAfterMerge.stdout)}`, details());
    }

    [ahead, behind] = parseAheadBehind(countsAfterMerge.stdout);
    if (ahead > 0 || behind > 0) {
      return fail(`vault is not synchronized with origin/main after fast-forward (ahead ${ahead}, behind ${behind})`, details());
    }
  }

  const push = await input.runCommand("git", ["-C", input.vaultPath, "push", "--dry-run", "origin", "main"], { cwd: input.vaultPath });
  if (push.exitCode !== 0) {
    return fail(`push dry-run failed: ${firstLine(push.stderr || push.stdout)}`, details());
  }

  return {
    job: "vault-sync-preflight",
    status: "pass",
    reason: fastForwarded ? "vault fast-forwarded, synchronized, and pushable" : "vault is clean, synchronized, and pushable",
    details: details(),
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
