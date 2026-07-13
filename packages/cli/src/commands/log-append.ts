import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { acquireLogLock, releaseLogLock } from "../utils/log-lock.js";
import { scanSensitiveContent } from "../utils/sensitive-content.js";

const ENTRY_RE = /^## \[(\d{4})-\d{2}-\d{2}\]/gm;

export interface LogAppendInput {
  vault: string;
  content: string;
  operationId?: string;
  strictLock?: boolean;
  /** Defaults true for legacy/public log-append callers. */
  recordLastOp?: boolean;
}
export interface LogAppendOutput {
  entries_before: number;
  entries_after: number;
  appended: boolean;
  humanHint: string;
}

type LogAppendRun = { exitCode: number; result: Result<LogAppendOutput> };

function operationMarker(operationId: string): Result<string> {
  if (!/^[0-9a-f]{64}$/.test(operationId)) {
    return err("USAGE", { message: "operationId must be a SHA-256 hex string" });
  }
  return ok(`<!-- skillwiki-page-publish:${operationId} -->`);
}

async function appendWhileLocked(
  logPath: string,
  content: string,
  marker: string | undefined,
): Promise<LogAppendRun> {
  let logText: string;
  try {
    logText = await readFile(logPath, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: logPath }) };
  }

  const entriesBefore = [...logText.matchAll(ENTRY_RE)].length;
  if (marker && logText.includes(marker)) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        entries_before: entriesBefore,
        entries_after: entriesBefore,
        appended: false,
        humanHint: `publication operation already appended (${entriesBefore} entries)`,
      }),
    };
  }

  const body = logText.replace(/\s+$/, "");
  const appendedContent = marker ? `${content}\n${marker}` : content;
  const written = await atomicWriteText(logPath, `${body}\n\n${appendedContent}\n`);
  if (!written.ok) {
    return { exitCode: ExitCode.WRITE_FAILED, result: written };
  }

  const entriesAfter = entriesBefore + 1;
  return {
    exitCode: ExitCode.OK,
    result: ok({
      entries_before: entriesBefore,
      entries_after: entriesAfter,
      appended: true,
      humanHint: `appended log entry (${entriesBefore}->${entriesAfter})`,
    }),
  };
}

/**
 * Append a single entry to log.md under a short-lived advisory lock.
 *
 * Vault convention is newest-entries-LAST (see log-rotate.ts), so the entry is
 * appended at the end of the file, separated from the prior block by one blank
 * line. The read-modify-write happens inside the lock to shrink the window in
 * which two single-machine sessions can interleave and produce a merge conflict.
 */
export async function runLogAppend(input: LogAppendInput): Promise<LogAppendRun> {
  try { await stat(join(input.vault, "SCHEMA.md")); }
  catch { return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) }; }

  const content = (input.content ?? "").trim();
  if (content.length === 0) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--content must be a non-empty log entry" }) };
  }

  const sensitive = scanSensitiveContent(content, { file: "log.md" });
  if (sensitive.length > 0) {
    return {
      exitCode: ExitCode.SENSITIVE_CONTENT_DETECTED,
      result: err("SENSITIVE_CONTENT_DETECTED", { file: "log.md", findings: sensitive }),
    };
  }

  let marker: string | undefined;
  if (input.operationId !== undefined) {
    const operation = operationMarker(input.operationId);
    if (!operation.ok) return { exitCode: ExitCode.USAGE, result: operation };
    marker = operation.data;
  }

  const acquired = await acquireLogLock(input.vault, input.strictLock ? { reclaimStale: false } : {});
  if (!acquired.ok) {
    if (acquired.error === "WRITE_FAILED") {
      return { exitCode: ExitCode.WRITE_FAILED, result: acquired };
    }
    return { exitCode: ExitCode.LOG_APPEND_LOCK_HELD, result: err("LOG_APPEND_LOCK_HELD", { vault: input.vault }) };
  }
  const lockHandle = acquired.data;

  const logPath = join(input.vault, "log.md");
  let outcome: LogAppendRun | undefined;
  let released: Result<{ released: boolean }> | undefined;
  try {
    outcome = await appendWhileLocked(logPath, content, marker);
  } catch (error: unknown) {
    outcome = {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "log-append", message: String(error) }),
    };
  } finally {
    released = releaseLogLock(lockHandle);
  }

  if (released === undefined || !released.ok) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "log-unlock" }),
    };
  }
  if (outcome === undefined) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "log-append" }),
    };
  }

  if (outcome.result.ok && outcome.result.data.appended && input.recordLastOp !== false) {
    try {
      appendLastOp(input.vault, {
        operation: "log-append",
        summary: `appended log entry (${outcome.result.data.entries_before}->${outcome.result.data.entries_after})`,
        files: ["log.md"],
        timestamp: new Date().toISOString(),
      });
    } catch (error: unknown) {
      return {
        exitCode: ExitCode.WRITE_FAILED,
        result: err("WRITE_FAILED", { stage: "last-op", message: String(error) }),
      };
    }
  }

  return outcome;
}
