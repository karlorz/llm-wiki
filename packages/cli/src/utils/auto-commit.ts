import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";
import { readLastOp, clearLastOp } from "./last-op.js";
import { parseDotenvFile } from "./dotenv.js";
import { configPath } from "../commands/config.js";

/**
 * Auto-commit vault changes after a successful command.
 * Enabled by default; set AUTO_COMMIT=false in ~/.skillwiki/.env to disable.
 * On failure: logs warning to stderr, does not change exit code.
 */
export async function postCommit(vault: string, exitCode: number): Promise<void> {
  // Guard: only auto-commit on success
  if (exitCode !== 0) return;

  // Guard: check config (default: enabled)
  const home = process.env.HOME ?? "";
  const dotenv = await parseDotenvFile(configPath(home));
  if (dotenv["AUTO_COMMIT"] === "false") return;

  // Guard: vault must be a git repo
  if (!existsSync(join(vault, ".git"))) return;

  // Guard: must have last-op entries (something was modified)
  const lastOps = readLastOp(vault);
  if (lastOps.length === 0) return;

  // Guard: must have dirty files
  const porcelain = git(vault, ["status", "--porcelain"]);
  if (!porcelain || porcelain.trim().length === 0) return;

  // Import gitStrict dynamically to avoid circular imports at module level
  const { gitStrict } = await import("./git.js");

  // Stage all changes
  try {
    gitStrict(vault, ["add", "-A"]);
    // Unstage last-op.json (same as sync push)
    try { gitStrict(vault, ["reset", "HEAD", "--", ".skillwiki/last-op.json"]); } catch (_e: unknown) { /* file may not be staged */ }
  } catch (e: unknown) {
    process.stderr.write(`auto-commit: git add failed: ${String(e)}\n`);
    return;
  }

  // Build commit message from last-op entries (same format as sync push)
  const commitMessage = lastOps.map(op => `${op.operation}: ${op.summary} (${op.files.length} files)`).join("; ");

  // Commit
  try {
    gitStrict(vault, ["commit", "-m", commitMessage]);
  } catch (e: unknown) {
    process.stderr.write(`auto-commit: git commit failed: ${String(e)}\n`);
    return;
  }

  // Clear last-op after successful commit
  clearLastOp(vault);
}
