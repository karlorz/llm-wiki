import { readFile, rename, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";
import { acquireLogLock, releaseLogLock } from "../utils/log-lock.js";

const ENTRY_RE = /^## \[(\d{4})-\d{2}-\d{2}\]/gm;

export interface LogAppendInput { vault: string; content: string }
export interface LogAppendOutput {
  entries_before: number;
  entries_after: number;
  appended: boolean;
  humanHint: string;
}

/**
 * Append a single entry to log.md under a short-lived advisory lock.
 *
 * Vault convention is newest-entries-LAST (see log-rotate.ts), so the entry is
 * appended at the end of the file, separated from the prior block by one blank
 * line. The read-modify-write happens inside the lock to shrink the window in
 * which two single-machine sessions can interleave and produce a merge conflict.
 */
export async function runLogAppend(input: LogAppendInput): Promise<{ exitCode: number; result: Result<LogAppendOutput> }> {
  try { await stat(join(input.vault, "SCHEMA.md")); }
  catch { return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) }; }

  const content = (input.content ?? "").trim();
  if (content.length === 0) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--content must be a non-empty log entry" }) };
  }

  const acquired = await acquireLogLock(input.vault);
  if (!acquired.ok) {
    return { exitCode: ExitCode.LOG_APPEND_LOCK_HELD, result: err("LOG_APPEND_LOCK_HELD", { vault: input.vault }) };
  }
  const lockHandle = acquired.data;

  const logPath = join(input.vault, "log.md");
  try {
    let logText: string;
    try { logText = await readFile(logPath, "utf8"); }
    catch { return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: logPath }) }; }

    const entriesBefore = [...logText.matchAll(ENTRY_RE)].length;
    const body = logText.replace(/\s+$/, "");
    const next = `${body}\n\n${content}\n`;

    try {
      const tmp = logPath + ".tmp";
      await writeFile(tmp, next, "utf8");
      await rename(tmp, logPath);
    } catch (e: unknown) {
      return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
    }

    appendLastOp(input.vault, {
      operation: "log-append",
      summary: `appended log entry (${entriesBefore}->${entriesBefore + 1})`,
      files: ["log.md"],
      timestamp: new Date().toISOString(),
    });

    const entriesAfter = entriesBefore + 1;
    return {
      exitCode: ExitCode.OK,
      result: ok({ entries_before: entriesBefore, entries_after: entriesAfter, appended: true, humanHint: `appended log entry (${entriesBefore}->${entriesAfter})` }),
    };
  } finally {
    releaseLogLock(lockHandle);
  }
}
