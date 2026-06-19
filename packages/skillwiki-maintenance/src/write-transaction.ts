import type { CommandRunner, ErrResult, JobCheck, MaintenanceJobId, Result } from "./types.js";

export interface WriteTransactionInput<TJobData = unknown> {
  job: MaintenanceJobId;
  repoPath: string;
  allowlist: string[];
  commitMessage: string;
  runCommand: CommandRunner;
  run: () => Promise<Result<TJobData>>;
}

export interface WriteTransactionDetails<TJobData = unknown> {
  changedFiles: string[];
  allowlist: string[];
  allowlistViolations: string[];
  committed: boolean;
  commitSha?: string;
  jobData?: TJobData;
  jobError?: ErrResult;
  ahead?: number;
  behind?: number;
}

export async function runWriteTransaction<TJobData = unknown>(
  input: WriteTransactionInput<TJobData>
): Promise<JobCheck<WriteTransactionDetails<TJobData>>> {
  const clean = await cleanState(input);
  if (!clean.ok) return clean.check;

  const synced = await syncedWithOriginMain(input);
  if (!synced.ok) return synced.check;

  const jobResult = await input.run();
  if (!jobResult.ok) {
    return cleanupAfterFailedJob(input, jobResult);
  }

  const after = await statusFiles(input);
  if (!after.ok) return after.check;
  if (after.files.length === 0) {
    return {
      job: input.job,
      status: "pass",
      reason: "writing job produced no changes",
      details: details(input, { changedFiles: [], committed: false, jobData: jobResult.data }),
    };
  }

  const violations = after.files.filter((file) => !isAllowed(file, input.allowlist));
  if (violations.length > 0) {
    return fail(input, `writing job changed files outside allowlist: ${violations.join(", ")}`, {
      changedFiles: after.files,
      allowlistViolations: violations,
      jobData: jobResult.data,
    });
  }

  const add = await input.runCommand("git", ["-C", input.repoPath, "add", "--", ...after.files], { cwd: input.repoPath });
  if (add.exitCode !== 0) {
    return fail(input, firstLine(add.stderr || add.stdout || "git add failed"), {
      changedFiles: after.files,
      allowlistViolations: [],
      jobData: jobResult.data,
    });
  }

  const commit = await input.runCommand("git", ["-C", input.repoPath, "commit", "-m", input.commitMessage], {
    cwd: input.repoPath,
  });
  if (commit.exitCode !== 0) {
    return fail(input, firstLine(commit.stderr || commit.stdout || "git commit failed"), {
      changedFiles: after.files,
      allowlistViolations: [],
      jobData: jobResult.data,
    });
  }

  const sha = await input.runCommand("git", ["-C", input.repoPath, "rev-parse", "HEAD"], { cwd: input.repoPath });
  return {
    job: input.job,
    status: "pass",
    reason: "writing job committed allowed changes",
    details: details(input, {
      changedFiles: after.files,
      allowlistViolations: [],
      committed: true,
      commitSha: sha.exitCode === 0 ? sha.stdout.trim() : undefined,
      jobData: jobResult.data,
    }),
  };
}

async function cleanState<TJobData>(
  input: WriteTransactionInput<TJobData>
): Promise<{ ok: true } | { ok: false; check: JobCheck<WriteTransactionDetails<TJobData>> }> {
  const status = await statusFiles(input);
  if (!status.ok) return status;
  if (status.files.length > 0) {
    return {
      ok: false,
      check: fail(input, `repo is dirty before job: ${status.files[0]}`, {
        changedFiles: status.files,
        allowlistViolations: [],
      }),
    };
  }
  return { ok: true };
}

async function syncedWithOriginMain<TJobData>(
  input: WriteTransactionInput<TJobData>
): Promise<{ ok: true } | { ok: false; check: JobCheck<WriteTransactionDetails<TJobData>> }> {
  const fetch = await input.runCommand("git", ["-C", input.repoPath, "fetch", "origin", "main"], { cwd: input.repoPath });
  if (fetch.exitCode !== 0) {
    return {
      ok: false,
      check: fail(input, `git fetch failed: ${firstLine(fetch.stderr || fetch.stdout)}`, {
        changedFiles: [],
        allowlistViolations: [],
      }),
    };
  }

  const counts = await input.runCommand("git", ["-C", input.repoPath, "rev-list", "--left-right", "--count", "HEAD...origin/main"], {
    cwd: input.repoPath,
  });
  if (counts.exitCode !== 0) {
    return {
      ok: false,
      check: fail(input, `git sync check failed: ${firstLine(counts.stderr || counts.stdout)}`, {
        changedFiles: [],
        allowlistViolations: [],
      }),
    };
  }

  const [ahead, behind] = parseAheadBehind(counts.stdout);
  if (ahead > 0 || behind > 0) {
    return {
      ok: false,
      check: fail(input, `repo is not synchronized with origin/main (ahead ${ahead}, behind ${behind})`, {
        changedFiles: [],
        allowlistViolations: [],
        ahead,
        behind,
      }),
    };
  }

  return { ok: true };
}

async function statusFiles<TJobData>(
  input: WriteTransactionInput<TJobData>
): Promise<{ ok: true; files: string[] } | { ok: false; check: JobCheck<WriteTransactionDetails<TJobData>> }> {
  const status = await statusEntries(input);
  if (!status.ok) return status;
  return { ok: true, files: status.entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right)) };
}

async function statusEntries<TJobData>(
  input: WriteTransactionInput<TJobData>
): Promise<{ ok: true; entries: StatusEntry[] } | { ok: false; check: JobCheck<WriteTransactionDetails<TJobData>> }> {
  const status = await input.runCommand("git", ["-C", input.repoPath, "status", "--porcelain", "--untracked-files=all"], {
    cwd: input.repoPath,
  });
  if (status.exitCode !== 0) {
    return {
      ok: false,
      check: fail(input, `git status failed: ${firstLine(status.stderr || status.stdout)}`, {
        changedFiles: [],
        allowlistViolations: [],
      }),
    };
  }
  return { ok: true, entries: statusEntriesFromPorcelain(status.stdout) };
}

async function cleanupAfterFailedJob<TJobData>(
  input: WriteTransactionInput<TJobData>,
  jobError: ErrResult
): Promise<JobCheck<WriteTransactionDetails<TJobData>>> {
  const after = await statusEntries(input);
  if (!after.ok) return after.check;
  const files = after.entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  const violations = files.filter((file) => !isAllowed(file, input.allowlist));
  if (violations.length > 0) {
    return fail(input, `writing job failed before commit and changed files outside allowlist: ${violations.join(", ")}`, {
      changedFiles: files,
      allowlistViolations: violations,
      jobError,
    });
  }

  const tracked = after.entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  const untracked = after.entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  if (tracked.length > 0) {
    const restore = await input.runCommand("git", ["-C", input.repoPath, "restore", "--staged", "--worktree", "--", ...tracked], {
      cwd: input.repoPath,
    });
    if (restore.exitCode !== 0) {
      return fail(input, `writing job failed before commit; cleanup restore failed: ${firstLine(restore.stderr || restore.stdout)}`, {
        changedFiles: files,
        allowlistViolations: [],
        jobError,
      });
    }
  }
  if (untracked.length > 0) {
    const clean = await input.runCommand("git", ["-C", input.repoPath, "clean", "-f", "--", ...untracked], { cwd: input.repoPath });
    if (clean.exitCode !== 0) {
      return fail(input, `writing job failed before commit; cleanup clean failed: ${firstLine(clean.stderr || clean.stdout)}`, {
        changedFiles: files,
        allowlistViolations: [],
        jobError,
      });
    }
  }

  const cleaned = await statusEntries(input);
  if (!cleaned.ok) return cleaned.check;
  if (cleaned.entries.length > 0) {
    const remaining = cleaned.entries.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
    return fail(input, `writing job failed before commit; cleanup left dirty files: ${remaining.join(", ")}`, {
      changedFiles: remaining,
      allowlistViolations: remaining.filter((file) => !isAllowed(file, input.allowlist)),
      jobError,
    });
  }

  return fail(input, files.length > 0 ? "writing job failed before commit; cleaned allowed changes" : "writing job failed before commit", {
    changedFiles: files,
    allowlistViolations: [],
    jobError,
  });
}

function fail<TJobData>(
  input: WriteTransactionInput<TJobData>,
  reason: string,
  partial: Partial<WriteTransactionDetails<TJobData>>
): JobCheck<WriteTransactionDetails<TJobData>> {
  return {
    job: input.job,
    status: "fail",
    reason,
    details: details(input, { committed: false, ...partial }),
  };
}

function details<TJobData>(
  input: WriteTransactionInput<TJobData>,
  partial: Partial<WriteTransactionDetails<TJobData>>
): WriteTransactionDetails<TJobData> {
  return {
    changedFiles: partial.changedFiles ?? [],
    allowlist: [...input.allowlist],
    allowlistViolations: partial.allowlistViolations ?? [],
    committed: partial.committed ?? false,
    commitSha: partial.commitSha,
    jobData: partial.jobData,
    jobError: partial.jobError,
    ahead: partial.ahead,
    behind: partial.behind,
  };
}

interface StatusEntry {
  path: string;
  untracked: boolean;
}

function statusEntriesFromPorcelain(stdout: string): StatusEntry[] {
  return stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).map((line) => {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    const renameSeparator = " -> ";
    return {
      path: path.includes(renameSeparator) ? path.slice(path.lastIndexOf(renameSeparator) + renameSeparator.length) : path,
      untracked: status === "??",
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function isAllowed(path: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => matchesPattern(path, pattern));
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    const rest = normalizedPath.startsWith(`${prefix}/`) ? normalizedPath.slice(prefix.length + 1) : "";
    return rest.length > 0 && !rest.includes("/");
  }
  if (normalizedPattern.includes("*")) {
    return globPatternToRegExp(normalizedPattern).test(normalizedPath);
  }
  return normalizedPath === normalizedPattern;
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function parseAheadBehind(stdout: string): [number, number] {
  const [aheadRaw, behindRaw] = stdout.trim().split(/\s+/, 2);
  return [Number(aheadRaw || 0), Number(behindRaw || 0)];
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] || "no output";
}
