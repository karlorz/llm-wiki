import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "./types.js";

export interface MaintenanceLock {
  path: string;
  token: string;
  release: () => Promise<Result<{ released: boolean }>>;
}

export interface AcquireLockOptions {
  owner: string;
  now: Date;
  /** Total time to keep retrying a held lock before failing (ms). Defaults to 15 minutes. */
  waitMs?: number;
  /** Poll interval between acquire attempts while the lock is held (ms). Defaults to 2 seconds. */
  pollMs?: number;
  /** Lock TTL written as expires_at; an expired lock is reclaimable only when its owner pid is dead (ms). Defaults to 30 minutes. */
  ttlMs?: number;
}

interface LockOwnerRecord {
  owner?: string;
  acquired_at?: string;
  pid?: number;
  expires_at?: string;
  token?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readOwnerRecord(lockDir: string): LockOwnerRecord | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as LockOwnerRecord;
  } catch {
    return null;
  }
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: process exists but we cannot signal it — treat as alive.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function isExpired(record: LockOwnerRecord, now: number): boolean {
  if (typeof record.expires_at !== "string") return false;
  const expiresAt = Date.parse(record.expires_at);
  return Number.isFinite(expiresAt) && expiresAt < now;
}

/**
 * Preserve a stale owner record under <lock parent>/recovery/ and remove the
 * stale lock directory. Never reclaims by age alone; callers must already have
 * verified the recorded owner pid is dead. The recovery dir is a sibling of
 * the lock dir (mirroring managed-write-lock.ts) because the stale directory
 * itself is removed recursively.
 */
function reclaimStaleOwner(lockDir: string, record: LockOwnerRecord): Result<{ recoveryPath: string }> {
  try {
    const recoveryDir = join(dirname(lockDir), "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const recoveryPath = join(recoveryDir, `${stamp}-${record.token ?? "unknown-token"}.json`);
    writeFileSync(
      recoveryPath,
      JSON.stringify({
        recovered_at: new Date().toISOString(),
        recovery_reason: "owner_pid_dead",
        lock_dir: lockDir,
        lock: record,
      }, null, 2) + "\n",
      { flag: "wx" }
    );
    // Remove the live path only after the recovery bytes are durable.
    rmSync(lockDir, { recursive: true, force: true });
    return ok({ recoveryPath });
  } catch (error: unknown) {
    return err("LOCK_FAILED", error instanceof Error ? error.message : String(error));
  }
}

/** Release a maintenance lock only while the recorded ownership token still matches. */
export function releaseLock(lockDir: string, token: string): Result<{ released: boolean }> {
  const record = readOwnerRecord(lockDir);
  if (!record || record.token !== token) {
    return err("LOCK_HELD", {
      message: `maintenance lock ownership changed; refusing release: ${lockDir}`,
    });
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
    return ok({ released: true });
  } catch (error: unknown) {
    return err("LOCK_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export async function acquireLock(lockDir: string, options: AcquireLockOptions): Promise<Result<MaintenanceLock>> {
  const waitMs = options.waitMs ?? 900000;
  const pollMs = options.pollMs ?? 2000;
  const ttlMs = options.ttlMs ?? 1800000;
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    mkdirSync(dirname(lockDir), { recursive: true });
  } catch (error: unknown) {
    return err("LOCK_FAILED", error instanceof Error ? error.message : String(error));
  }

  const startedAt = Date.now();
  const deadline = startedAt + waitMs;

  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
        owner: options.owner,
        acquired_at: options.now.toISOString(),
        pid: process.pid,
        expires_at: new Date(options.now.getTime() + ttlMs).toISOString(),
        token,
      }, null, 2) + "\n", "utf8");
      return ok({
        path: lockDir,
        token,
        release: async () => releaseLock(lockDir, token),
      });
    } catch (error: unknown) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "EEXIST") {
        // A partially created lock dir would wedge every later run (unreadable owner.json).
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup only.
        }
        return err("LOCK_FAILED", error instanceof Error ? error.message : String(error));
      }
    }

    // EEXIST: reclaim only expired locks whose recorded owner pid is dead.
    const record = readOwnerRecord(lockDir);
    if (record && isExpired(record, Date.now()) && !isPidAlive(record.pid)) {
      const reclaimed = reclaimStaleOwner(lockDir, record);
      if (!reclaimed.ok) return reclaimed;
      continue; // retry acquire immediately after reclaim
    }

    if (Date.now() >= deadline) {
      return err("LOCK_HELD", {
        message: `maintenance lock is held: ${lockDir}`,
        waitedMs: Date.now() - startedAt,
        owner: record ?? undefined,
      });
    }
    await sleep(pollMs);
  }
}
