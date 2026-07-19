import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { appendLastOp } from "../utils/last-op.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { acquireLogLock, releaseLogLock } from "../utils/log-lock.js";
import { eventPathFor, writeLogEvent } from "../utils/log-events.js";
import { scanSensitiveContent } from "../utils/sensitive-content.js";

const ENTRY_RE = /^## \[(\d{4})-\d{2}-\d{2}\]/gm;

function countLogEntries(logText: string): number {
  let count = 0;
  for (const _ of logText.matchAll(ENTRY_RE)) count += 1;
  return count;
}

export interface LogAppendInput {
  vault: string;
  content: string;
  operationId?: string;
  strictLock?: boolean;
  /** Defaults true for legacy/public log-append callers. */
  recordLastOp?: boolean;
  /** When true (default if operationId set), also write immutable meta/log-events. */
  writeEvent?: boolean;
  /** Event kind for immutable log events (default: log-append). */
  eventKind?: string;
  eventTarget?: string;
  eventNote?: string;
  eventMetadata?: Record<string, unknown>;
}
export interface LogAppendOutput {
  entries_before: number;
  entries_after: number;
  appended: boolean;
  event_created?: boolean;
  event_path?: string;
  humanHint: string;
}

type LogAppendRun = { exitCode: number; result: Result<LogAppendOutput> };

/** Accept page-publish and generic log-op markers for stable operation IDs. */
export function operationMarkers(operationId: string): Result<string[]> {
  if (!/^[0-9a-f]{64}$/.test(operationId)) {
    return err("USAGE", { message: "operationId must be a SHA-256 hex string" });
  }
  return ok([
    `<!-- skillwiki-log-op:${operationId} -->`,
    `<!-- skillwiki-page-publish:${operationId} -->`,
  ]);
}

function preferredMarker(operationId: string, eventKind?: string): string {
  // Default keeps page-publish marker for backward-compatible callers that only
  // pass operationId (notably page-publish). Explicit non-publish kinds use log-op.
  if (!eventKind || eventKind === "page-publish") {
    return `<!-- skillwiki-page-publish:${operationId} -->`;
  }
  return `<!-- skillwiki-log-op:${operationId} -->`;
}

async function appendWhileLocked(
  logPath: string,
  content: string,
  markers: string[] | undefined,
  writeMarker: string | undefined,
): Promise<LogAppendRun> {
  let logText: string;
  try {
    logText = await readFile(logPath, "utf8");
  } catch {
    return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: logPath }) };
  }

  const entriesBefore = countLogEntries(logText);
  if (markers?.some((marker) => logText.includes(marker))) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        entries_before: entriesBefore,
        entries_after: entriesBefore,
        appended: false,
        humanHint: `operation already appended (${entriesBefore} entries)`,
      }),
    };
  }

  const body = logText.replace(/\s+$/, "");
  const appendedContent = writeMarker ? `${content}\n${writeMarker}` : content;
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

  let markers: string[] | undefined;
  let writeMarker: string | undefined;
  if (input.operationId !== undefined) {
    const operation = operationMarkers(input.operationId);
    if (!operation.ok) return { exitCode: ExitCode.USAGE, result: operation };
    markers = operation.data;
    writeMarker = preferredMarker(input.operationId, input.eventKind);
  }

  // Immutable event when explicitly requested — retry-safe via operation_id path.
  // Default off so page-publish (which writes its own event) is unchanged.
  let eventCreated: boolean | undefined;
  let eventPath: string | undefined;
  if (input.writeEvent === true && input.operationId) {
    // Stable day bucket so retries with the same operation id hit the same path.
    const day = (input.eventMetadata?.day as string | undefined)
      || content.match(/\[(\d{4}-\d{2}-\d{2})\]/)?.[1]
      || new Date().toISOString().slice(0, 10);
    const event = await writeLogEvent(input.vault, {
      schema: "skillwiki-log-event/v1",
      operation_id: input.operationId,
      occurred_at: `${day}T00:00:00.000Z`,
      host_id: hostname() || "localhost",
      actor: "skillwiki-cli",
      kind: input.eventKind || "log-append",
      target: input.eventTarget || "log.md",
      note: input.eventNote || content.split("\n")[0].slice(0, 500),
      metadata: {
        ...(input.eventMetadata || {}),
      },
    });
    if (!event.ok) {
      // Same operation id already stored with different payload — treat as applied.
      if (event.error === "EVENT_IDENTITY_COLLISION") {
        eventCreated = false;
        eventPath = eventPathFor({
          schema: "skillwiki-log-event/v1",
          operation_id: input.operationId,
          occurred_at: `${day}T00:00:00.000Z`,
          host_id: "localhost",
          actor: "skillwiki-cli",
          kind: input.eventKind || "log-append",
          target: input.eventTarget || "log.md",
          note: "collision",
          metadata: {},
        });
      } else {
        return {
          exitCode: event.error === "SENSITIVE_CONTENT_DETECTED"
            ? ExitCode.SENSITIVE_CONTENT_DETECTED
            : ExitCode.WRITE_FAILED,
          result: event,
        };
      }
    } else {
      eventCreated = event.data.created;
      eventPath = event.data.path;
    }
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
  let outcome: LogAppendRun;
  let released: Result<{ released: boolean }> | undefined;
  try {
    outcome = await appendWhileLocked(logPath, content, markers, writeMarker);
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

  if (outcome.result.ok) {
    const alreadyApplied = !outcome.result.data.appended && eventCreated === false;
    outcome = {
      exitCode: outcome.exitCode,
      result: ok({
        ...outcome.result.data,
        ...(eventCreated !== undefined ? { event_created: eventCreated } : {}),
        ...(eventPath ? { event_path: eventPath } : {}),
        humanHint: alreadyApplied
          ? `operation already applied (${outcome.result.data.entries_before} entries)`
          : outcome.result.data.humanHint,
      }),
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
