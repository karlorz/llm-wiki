import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { runLint } from "./lint.js";
import { readLastOp, clearLastOp } from "../utils/last-op.js";
import { git, gitStrict } from "../utils/git.js";
import { acquireLock, releaseLock, readLock, getSessionId, getCwdHash, type LockFile } from "../utils/sync-lock.js";

export interface SyncStatusInput {
  vault: string;
  includeStashes?: boolean;
}

export interface StashEntry {
  ref: string;
  message: string;
  age_minutes: number;
}

export interface SyncStatusOutput {
  is_git_repo: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  last_commit: string;
  status: "clean" | "dirty" | "ahead" | "behind" | "not_a_repo";
  humanHint: string;
  stashes?: StashEntry[];
}

export function runSyncStatus(input: SyncStatusInput): { exitCode: number; result: Result<SyncStatusOutput> } {
  const vault = input.vault;
  const includeStashes = input.includeStashes ?? false;

  // 1. Check if the vault is a git repository
  if (!existsSync(join(vault, ".git"))) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: ok({
        is_git_repo: false,
        dirty: 0,
        ahead: 0,
        behind: 0,
        last_commit: "never",
        status: "not_a_repo",
        humanHint: "not a git repository",
      }),
    };
  }

  // 2. git status --porcelain → count dirty files
  const porcelain = git(vault, ["status", "--porcelain"]);
  const dirty = porcelain ? porcelain.split("\n").filter((l) => l.trim().length > 0).length : 0;

  // 3. git rev-list --left-right --count origin/HEAD...HEAD → ahead/behind
  const revOutput = git(vault, ["rev-list", "--left-right", "--count", "origin/HEAD...HEAD"]);
  let ahead = 0;
  let behind = 0;
  if (revOutput) {
    const parts = revOutput.split(/\s+/);
    behind = parseInt(parts[0]!, 10) || 0;
    ahead = parseInt(parts[1]!, 10) || 0;
  }

  // 4. git log -1 --format=%ct → last commit timestamp
  const tsRaw = git(vault, ["log", "-1", "--format=%ct"]);
  let last_commit: string;
  if (tsRaw) {
    const ts = parseInt(tsRaw, 10);
    if (!isNaN(ts) && ts > 0) {
      last_commit = new Date(ts * 1000).toISOString();
    } else {
      last_commit = "never";
    }
  } else {
    last_commit = "never";
  }

  // 5. Determine composite status
  let status: SyncStatusOutput["status"];
  if (dirty > 0) {
    status = "dirty";
  } else if (ahead > 0) {
    status = "ahead";
  } else if (behind > 0) {
    status = "behind";
  } else {
    status = "clean";
  }

  // 6. Build humanHint
  const hintLines: string[] = [
    `status: ${status}`,
    `dirty: ${dirty}`,
    `ahead: ${ahead}`,
    `behind: ${behind}`,
    `last_commit: ${last_commit}`,
  ];

  const exitCode = status === "clean"
    ? ExitCode.OK
    : ExitCode.LINT_HAS_WARNINGS;

  // 7. Optionally enumerate stashes
  let stashes: StashEntry[] | undefined;
  if (includeStashes) {
    stashes = enumerateStashes(vault);
  }

  const output: SyncStatusOutput = {
    is_git_repo: true,
    dirty,
    ahead,
    behind,
    last_commit,
    status,
    humanHint: hintLines.join("\n"),
  };

  if (stashes !== undefined) {
    output.stashes = stashes;
  }

  return {
    exitCode,
    result: ok(output),
  };
}

// ── sync push ──────────────────────────────────────────────────────────────

export interface SyncPushInput {
  vault: string;
}

export interface SyncPushOutput {
  files_committed: number;
  commit_message: string;
  pushed: boolean;
  humanHint: string;
}

export async function runSyncPush(input: SyncPushInput): Promise<{ exitCode: number; result: Result<SyncPushOutput> }> {
  const vault = input.vault;

  // 1. Verify vault is a git repo
  if (!existsSync(join(vault, ".git"))) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("NOT_A_GIT_REPO", { path: vault }),
    };
  }

  // 2. Check for changes
  const porcelain = git(vault, ["status", "--porcelain"]);
  const dirtyFiles = porcelain ? porcelain.split("\n").filter((l) => l.trim().length > 0) : [];

  if (dirtyFiles.length === 0) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        files_committed: 0,
        commit_message: "",
        pushed: false,
        humanHint: "nothing to commit, working tree clean",
      }),
    };
  }

  // 3. Run lint — abort on errors
  const lintResult = await runLint({ vault, days: 90, lines: 200, logThreshold: 500 });
  if (lintResult.result.ok && lintResult.result.data.summary.errors > 0) {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: err("LINT_ERRORS_BLOCK_PUSH", {
        errors: lintResult.result.data.summary.errors,
        buckets: lintResult.result.data.by_severity.error,
      }),
    };
  }

  // 4. Stage all
  try {
    gitStrict(vault, ["add", "-A"]);
    // Unstage last-op.json if it was staged (it should not be committed)
    try { gitStrict(vault, ["reset", "HEAD", "--", ".skillwiki/last-op.json"]); } catch (_e: unknown) { /* file may not be staged */ }
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.SYNC_PUSH_FAILED,
      result: err("GIT_ADD_FAILED", { message: String(e) }),
    };
  }

  // 5. Commit
  const lastOps = readLastOp(vault);
  let commitMessage: string;
  if (lastOps.length > 0) {
    commitMessage = lastOps.map(op => `${op.operation}: ${op.summary} (${op.files.length} files)`).join("; ");
  } else {
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    commitMessage = `sync: vault update ${timestamp}`;
  }
  try {
    gitStrict(vault, ["commit", "-m", commitMessage]);
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.SYNC_PUSH_FAILED,
      result: err("GIT_COMMIT_FAILED", { message: String(e) }),
    };
  }

  // Clear last-op after successful commit
  clearLastOp(vault);

  // 6. Push
  let pushed = false;
  try {
    gitStrict(vault, ["push", "origin", "HEAD"]);
    pushed = true;
  } catch (e: unknown) {
    // Commit succeeded but push failed — report partial success
    return {
      exitCode: ExitCode.SYNC_PUSH_FAILED,
      result: ok({
        files_committed: dirtyFiles.length,
        commit_message: commitMessage,
        pushed: false,
        humanHint: `committed ${dirtyFiles.length} file(s) but push failed: ${String(e)}`,
      }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      files_committed: dirtyFiles.length,
      commit_message: commitMessage,
      pushed,
      humanHint: `committed and pushed ${dirtyFiles.length} file(s)`,
    }),
  };
}

// ── sync pull ──────────────────────────────────────────────────────────────

/**
 * Enumerate all stashes from git reflog, returning array of StashEntry.
 */
function enumerateStashes(vault: string): StashEntry[] {
  // Use git log -g to get reflog entries with commit timestamp
  const output = git(vault, ["log", "--format=%gd%x09%s%x09%ct", "-g", "stash"]);
  if (!output) return [];

  const now = Date.now();
  const stashes: StashEntry[] = [];
  const lines = output.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ref = parts[0]!;
    const message = parts[1]!;
    const ctStr = parts[2]!;
    const ct = parseInt(ctStr, 10);
    if (isNaN(ct)) continue;

    const age_minutes = Math.floor((now - ct * 1000) / (60 * 1000));
    stashes.push({ ref, message, age_minutes });
  }

  return stashes;
}

export interface SyncPullInput {
  vault: string;
}

export interface SyncPullOutput {
  fetched: boolean;
  pulled: boolean;
  files_updated: number;
  conflicts: number;
  lint_errors: number;
  lint_warnings: number;
  humanHint: string;
}

export async function runSyncPull(input: SyncPullInput): Promise<{ exitCode: number; result: Result<SyncPullOutput> }> {
  const vault = input.vault;

  // 1. Verify vault is a git repo
  if (!existsSync(join(vault, ".git"))) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("NOT_A_GIT_REPO", { path: vault }),
    };
  }

  // 2. Fetch
  let fetched = false;
  try {
    gitStrict(vault, ["fetch", "origin"]);
    fetched = true;
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.SYNC_PULL_FAILED,
      result: err("GIT_FETCH_FAILED", { message: String(e) }),
    };
  }

  // 3. Pull with rebase
  let pulled = false;
  let conflicts = 0;
  let filesUpdated = 0;
  try {
    const pullOutput = gitStrict(vault, ["pull", "--rebase", "origin", "HEAD"]);
    pulled = true;
    // Count files changed from the pull output
    const fileMatch = pullOutput.match(/(\d+) file[s]? changed/);
    if (fileMatch) filesUpdated = parseInt(fileMatch[1]!, 10);
  } catch (e: unknown) {
    // Check for rebase conflicts
    const errString = String(e);
    if (errString.includes("conflict")) {
      const porcelain = git(vault, ["diff", "--name-only", "--diff-filter=U"]);
      conflicts = porcelain ? porcelain.split("\n").filter((l) => l.trim().length > 0).length : 0;
      return {
        exitCode: ExitCode.SYNC_PULL_FAILED,
        result: ok({
          fetched,
          pulled: false,
          files_updated: 0,
          conflicts,
          lint_errors: 0,
          lint_warnings: 0,
          humanHint: `pull failed with ${conflicts} conflict(s) — resolve manually`,
        }),
      };
    }
    return {
      exitCode: ExitCode.SYNC_PULL_FAILED,
      result: err("GIT_PULL_FAILED", { message: errString }),
    };
  }

  // 4. Run lint after pull
  let lintErrors = 0;
  let lintWarnings = 0;
  const lintResult = await runLint({ vault, days: 90, lines: 200, logThreshold: 500 });
  if (lintResult.result.ok) {
    lintErrors = lintResult.result.data.summary.errors;
    lintWarnings = lintResult.result.data.summary.warnings;
  }

  const hintParts: string[] = [];
  if (filesUpdated > 0) hintParts.push(`updated ${filesUpdated} file(s)`);
  else hintParts.push("already up to date");
  if (lintErrors > 0) hintParts.push(`${lintErrors} lint error(s)`);
  if (lintWarnings > 0) hintParts.push(`${lintWarnings} lint warning(s)`);

  const exitCode = lintErrors > 0
    ? ExitCode.LINT_HAS_ERRORS
    : lintWarnings > 0
      ? ExitCode.LINT_HAS_WARNINGS
      : ExitCode.OK;

  return {
    exitCode,
    result: ok({
      fetched,
      pulled,
      files_updated: filesUpdated,
      conflicts,
      lint_errors: lintErrors,
      lint_warnings: lintWarnings,
      humanHint: hintParts.join(", "),
    }),
  };
}

// ── sync lock ──────────────────────────────────────────────────────────────

export interface SyncPeersInput {
  vault: string;
}

export interface PeerLock {
  session_id: string;
  pid: number;
  cwd: string;
  summary: string;
  acquired: string;
  expires: string;
  is_self: boolean;
}

export interface WikiSyncStash {
  ref: string;
  session_id: string;
  cwd_hash: string;
  timestamp: string;
  summary: string;
  age_minutes: number;
}

export interface SyncPeersOutput {
  locks: PeerLock[];
  stashes: WikiSyncStash[];
  humanHint: string;
}

/**
 * List active locks and recent wiki-sync:* stashes.
 */
export function runSyncPeers(input: SyncPeersInput): { exitCode: number; result: Result<SyncPeersOutput> } {
  const vault = input.vault;

  // 1. Read lock file if present
  const locks: PeerLock[] = [];
  const existingLock = readLock(vault);
  if (existingLock) {
    const self = existingLock.session_id === getSessionId();
    locks.push({ ...existingLock, is_self: self });
  }

  // 2. Enumerate wiki-sync:* stashes
  const allStashes = enumerateStashes(vault);
  const stashes: WikiSyncStash[] = [];

  for (const stash of allStashes) {
    // The stash message includes "On <branch>: " prefix added by git
    // Extract the actual message after the ": "
    let actualMessage = stash.message;
    const prefixMatch = stash.message.match(/^On [^:]+:\s*(.*)/);
    if (prefixMatch) {
      actualMessage = prefixMatch[1]!;
    }

    // Parse wiki-sync:{session}:{cwd}:{timestamp}:{summary} format
    // The timestamp is ISO8601 (e.g., 2026-05-23T03:25:00Z) so we need a regex that matches it exactly
    const match = actualMessage.match(/^wiki-sync:([^:]+):([^:]+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z):(.*)$/);
    if (!match) continue;

    const session_id = match[1]!;
    const cwd_hash = match[2]!;
    const timestamp = match[3]!;
    const summary = match[4]!;

    stashes.push({
      ref: stash.ref,
      session_id,
      cwd_hash,
      timestamp,
      summary,
      age_minutes: stash.age_minutes,
    });
  }

  const hintParts: string[] = [];
  if (locks.length > 0) hintParts.push(`${locks.length} lock(s)`);
  if (stashes.length > 0) hintParts.push(`${stashes.length} wiki-sync stash(es)`);
  const humanHint = hintParts.length > 0 ? hintParts.join(", ") : "no peers detected";

  return {
    exitCode: ExitCode.OK,
    result: ok({
      locks,
      stashes,
      humanHint,
    }),
  };
}

// ── sync lock ──────────────────────────────────────────────────────────────

export interface SyncLockInput {
  vault: string;
  summary?: string;
  ttlMinutes?: number;
  force?: boolean;
  sessionId?: string;
}

export interface SyncLockOutput {
  acquired: boolean;
  lock: LockFile;
  held_by?: LockFile;
  humanHint: string;
}

export function runSyncLock(input: SyncLockInput): { exitCode: number; result: Result<SyncLockOutput> } {
  const vault = input.vault;

  // Verify vault path exists
  if (!existsSync(vault)) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("VAULT_PATH_INVALID", { path: vault }),
    };
  }

  const result = acquireLock(vault, {
    sessionId: input.sessionId,
    summary: input.summary,
    ttlMinutes: input.ttlMinutes,
    force: input.force,
  });

  if (result.ok) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        acquired: true,
        lock: result.lock,
        humanHint: `lock acquired for ${result.lock.summary} (expires ${result.lock.expires})`,
      }),
    };
  } else {
    return {
      exitCode: ExitCode.SYNC_LOCK_HELD,
      result: ok({
        acquired: false,
        lock: result.held,
        held_by: result.held,
        humanHint: `lock held by session ${result.held.session_id} (PID ${result.held.pid}) for ${result.held.summary}`,
      }),
    };
  }
}

// ── sync unlock ────────────────────────────────────────────────────────────

export interface SyncUnlockInput {
  vault: string;
  sessionId?: string;
  force?: boolean;
}

export interface SyncUnlockOutput {
  released: boolean;
  prior?: { session_id: string; pid: number; summary: string };
  humanHint: string;
}

export function runSyncUnlock(input: SyncUnlockInput): { exitCode: number; result: Result<SyncUnlockOutput> } {
  const vault = input.vault;

  // Verify vault path exists
  if (!existsSync(vault)) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("VAULT_PATH_INVALID", { path: vault }),
    };
  }

  const result = releaseLock(vault, { sessionId: input.sessionId, force: input.force });

  let humanHint: string;
  if (result.released && result.prior) {
    humanHint = `lock force-released (was held by session ${result.prior.session_id}, PID ${result.prior.pid})`;
  } else if (result.released) {
    humanHint = "lock released";
  } else {
    humanHint = "lock not held by this session (no-op)";
  }

  const output: SyncUnlockOutput = {
    released: result.released,
    humanHint,
  };
  if (result.prior) {
    output.prior = {
      session_id: result.prior.session_id,
      pid: result.prior.pid,
      summary: result.prior.summary,
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok(output),
  };
}
