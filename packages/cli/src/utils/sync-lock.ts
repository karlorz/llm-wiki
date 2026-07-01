import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface LockFile {
  session_id: string;
  pid: number;
  cwd: string;
  summary: string;
  acquired: string;
  expires: string;
}

/**
 * Get session ID from environment variables with fallback precedence:
 * 1. CLAUDE_SESSION_ID env var
 * 2. SKILLWIKI_SESSION_ID env var
 * 3. process.pid as string
 * 4. "unknown"
 */
function getEnvSessionId(): string | undefined {
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  if (process.env.SKILLWIKI_SESSION_ID) return process.env.SKILLWIKI_SESSION_ID;
  return undefined;
}

export function getSessionId(): string {
  const envSessionId = getEnvSessionId();
  if (envSessionId) return envSessionId;
  return process.pid.toString();
}

/**
 * Get first 8 hex chars of sha256(cwd || process.cwd())
 */
export function getCwdHash(cwd?: string): string {
  const path = cwd || process.cwd();
  const hash = createHash("sha256").update(path).digest("hex");
  return hash.slice(0, 8);
}

export function getCliSessionId(cwd?: string): string {
  const envSessionId = getEnvSessionId();
  if (envSessionId) return envSessionId;
  return `cli-${getCwdHash(cwd)}`;
}

/**
 * Compute lockfile path: <vault>/.skillwiki/sync.lock
 */
export function lockPath(vault: string): string {
  return join(vault, ".skillwiki", "sync.lock");
}

/**
 * Read lockfile from disk. Returns null if missing or invalid.
 */
export function readLock(vault: string): LockFile | null {
  const path = lockPath(vault);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as LockFile;
  } catch {
    return null;
  }
}

/**
 * Check if lock is stale (expires < now)
 */
export function isStale(lock: LockFile, now?: Date): boolean {
  const nowTime = (now ?? new Date()).getTime();
  const expiresTime = new Date(lock.expires).getTime();
  return expiresTime < nowTime;
}

/**
 * Atomically acquire lock. Returns { ok: true, lock } on success,
 * or { ok: false, held } if lock is held by another session and not stale.
 */
export function acquireLock(
  vault: string,
  opts: {
    sessionId?: string;
    summary?: string;
    ttlMinutes?: number;
    force?: boolean;
  } = {},
): { ok: true; lock: LockFile } | { ok: false; held: LockFile } {
  const path = lockPath(vault);
  const dir = join(vault, ".skillwiki");

  // Create .skillwiki dir if missing
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sessionId = opts.sessionId ?? getSessionId();
  const summary = opts.summary ?? "skillwiki sync";
  const ttlMinutes = opts.ttlMinutes ?? 30;
  const force = opts.force ?? false;

  const now = new Date();
  const acquired = now.toISOString();
  const expires = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  const lock: LockFile = {
    session_id: sessionId,
    pid: process.pid,
    cwd: process.cwd(),
    summary,
    acquired,
    expires,
  };

  // Try atomic O_EXCL write
  try {
    const content = JSON.stringify(lock, null, 2) + "\n";
    writeFileSync(path, content, { flag: "wx" }); // O_EXCL | O_CREAT
    return { ok: true, lock };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw err;
  }

  // File exists; check if stale or force
  const existing = readLock(vault);
  if (!existing) {
    // Couldn't parse; overwrite
    writeLockedFile(path, lock);
    return { ok: true, lock };
  }

  if (force || isStale(existing)) {
    // Overwrite atomically
    writeLockedFile(path, lock);
    return { ok: true, lock };
  }

  // Not stale and not forced; refuse
  return { ok: false, held: existing };
}

/**
 * Write lockfile atomically via temp + rename
 */
function writeLockedFile(path: string, lock: LockFile): void {
  const tmp = path + ".tmp";
  const content = JSON.stringify(lock, null, 2) + "\n";
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Release lock if held by this session. Returns { released: true } if deleted,
 * { released: false } if not held by us (no-op).
 *
 * With { force: true }, releases the lock regardless of holder. When the lock
 * was held by another session, the prior LockFile is returned so the caller
 * can surface holder info to the operator.
 */
export function releaseLock(
  vault: string,
  opts: { sessionId?: string; force?: boolean } = {},
): { released: boolean; prior?: LockFile } {
  const path = lockPath(vault);
  if (!existsSync(path)) {
    return { released: false };
  }

  const sessionId = opts.sessionId ?? getSessionId();
  const existing = readLock(vault);

  if (opts.force) {
    try {
      unlinkSync(path);
      // prior is only meaningful when the lock was held by someone else
      const prior =
        existing && existing.session_id !== sessionId ? existing : undefined;
      return { released: true, prior };
    } catch {
      return { released: false };
    }
  }

  if (!existing || existing.session_id !== sessionId) {
    // Not held by us; don't delete
    return { released: false };
  }

  try {
    unlinkSync(path);
    return { released: true };
  } catch {
    return { released: false };
  }
}
