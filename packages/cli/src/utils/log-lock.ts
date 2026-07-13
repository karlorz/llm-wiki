import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";

/**
 * Dedicated, short-lived advisory lock for log.md appends.
 *
 * Deliberately separate from sync-lock.ts: a `skillwiki sync` holds its lock
 * for up to 30 minutes, but a log append is sub-second. Sharing one lock would
 * let a long sync block every retro write. This lock lives at a distinct path
 * and is force-broken after a short staleness window.
 */
export function logLockPath(vault: string): string {
  return join(vault, ".skillwiki", "log-append.lock");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AcquireLogLockOpts {
  /** Total time to keep retrying before giving up (ms). */
  retryMs?: number;
  /** Poll interval between acquire attempts (ms). */
  pollMs?: number;
  /** A held lock older than this is considered stale and force-broken (ms). */
  staleMs?: number;
  /** Whether a stale lock can be reclaimed. Defaults to true for log appends. */
  reclaimStale?: boolean;
}

interface LogLockFile {
  owner_token: string;
  acquired: string;
}

export interface LogLockHandle {
  vault: string;
  path: string;
  ownerToken: string;
  acquired: string;
}

function readLogLock(path: string): LogLockFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LogLockFile;
  } catch {
    return null;
  }
}

/**
 * Acquire the log-append lock via atomic O_EXCL write, retrying within a short
 * budget. A lock whose mtime is older than `staleMs` is broken when
 * `reclaimStale` is true (the default for an append). Successful acquisition
 * returns the ownership handle required for release.
 */
export async function acquireLogLock(
  vault: string,
  opts: AcquireLogLockOpts = {},
): Promise<Result<LogLockHandle>> {
  const retryMs = opts.retryMs ?? 2000;
  const pollMs = opts.pollMs ?? 50;
  const staleMs = opts.staleMs ?? 10000;
  const reclaimStale = opts.reclaimStale ?? true;

  const path = logLockPath(vault);
  const dir = join(vault, ".skillwiki");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + retryMs;
  const ownerToken = randomBytes(16).toString("hex");
  const acquired = new Date().toISOString();
  const content = JSON.stringify({ pid: process.pid, owner_token: ownerToken, acquired }) + "\n";

  for (;;) {
    try {
      writeFileSync(path, content, { flag: "wx" }); // O_EXCL | O_CREAT
      return ok({ vault, path, ownerToken, acquired });
    } catch (error: unknown) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "EEXIST") {
        return err("WRITE_FAILED", { path, message: String(error) });
      }
    }

    // Held — break it if stale, else wait and retry.
    if (reclaimStale) {
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > staleMs) {
          unlinkSync(path);
          continue; // retry acquire immediately
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry acquire immediately.
        continue;
      }
    }

    if (Date.now() >= deadline) return err("LOG_APPEND_LOCK_HELD", { vault });
    await sleep(pollMs);
  }
}

/** Release a log lock only when the supplied acquisition handle still owns it. */
export function releaseLogLock(handle: LogLockHandle): Result<{ released: boolean }> {
  const existing = readLogLock(handle.path);
  if (
    !existing ||
    existing.owner_token !== handle.ownerToken ||
    existing.acquired !== handle.acquired
  ) {
    return err("LOG_APPEND_LOCK_HELD", {
      message: "log append lock ownership changed; refusing release",
    });
  }

  try {
    unlinkSync(handle.path);
    return ok({ released: true });
  } catch (error: unknown) {
    return err("WRITE_FAILED", { path: handle.path, message: String(error) });
  }
}
