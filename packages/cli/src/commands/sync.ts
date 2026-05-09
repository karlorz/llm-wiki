import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { runLint } from "./lint.js";
import { readLastOp, clearLastOp } from "../utils/last-op.js";
import { git, gitStrict } from "../utils/git.js";

export interface SyncStatusInput {
  vault: string;
}

export interface SyncStatusOutput {
  is_git_repo: boolean;
  dirty: number;
  ahead: number;
  behind: number;
  last_commit: string;
  status: "clean" | "dirty" | "ahead" | "behind" | "not_a_repo";
  humanHint: string;
}

export function runSyncStatus(input: SyncStatusInput): { exitCode: number; result: Result<SyncStatusOutput> } {
  const vault = input.vault;

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

  return {
    exitCode,
    result: ok({
      is_git_repo: true,
      dirty,
      ahead,
      behind,
      last_commit,
      status,
      humanHint: hintLines.join("\n"),
    }),
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
    try { gitStrict(vault, ["reset", "HEAD", "--", ".skillwiki/last-op.json"]); } catch {}
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
  } catch (e) {
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
