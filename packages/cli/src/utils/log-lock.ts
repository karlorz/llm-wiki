import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}

/**
 * Acquire the log-append lock via atomic O_EXCL write, retrying within a short
 * budget. A lock whose mtime is older than `staleMs` is broken (an append
 * should never take that long). Returns { ok: true } on acquire, else
 * { ok: false } on timeout.
 */
export async function acquireLogLock(
  vault: string,
  opts: AcquireLogLockOpts = {},
): Promise<{ ok: boolean }> {
  const retryMs = opts.retryMs ?? 2000;
  const pollMs = opts.pollMs ?? 50;
  const staleMs = opts.staleMs ?? 10000;

  const path = logLockPath(vault);
  const dir = join(vault, ".skillwiki");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const deadline = Date.now() + retryMs;
  const content = JSON.stringify({ pid: process.pid, acquired: new Date().toISOString() }) + "\n";

  for (;;) {
    try {
      writeFileSync(path, content, { flag: "wx" }); // O_EXCL | O_CREAT
      return { ok: true };
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
    }

    // Held — break it if stale, else wait and retry.
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

    if (Date.now() >= deadline) return { ok: false };
    await sleep(pollMs);
  }
}

/** Release the log-append lock. Best-effort; ignores a missing lockfile. */
export function releaseLogLock(vault: string): void {
  try {
    unlinkSync(logLockPath(vault));
  } catch {
    // ENOENT or already released — nothing to do.
  }
}
