import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { git } from "./git.js";

export interface ManagedWriteLockHandle {
  vault: string;
  path: string;
  ownerToken: string;
  acquired: string;
}

interface ManagedWriteLockRecord {
  pid?: number;
  owner_token?: string;
  acquired?: string;
  command?: string;
}

export function managedWriteLockPath(vault: string): string {
  const gitPath = git(vault, ["rev-parse", "--git-path", "vault-sync/managed-write.lock"]);
  if (gitPath) return gitPath.startsWith("/") ? gitPath : join(vault, gitPath);
  return join(vault, ".skillwiki", "managed-write.lock");
}

function readLockRecord(path: string): ManagedWriteLockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ManagedWriteLockRecord;
  } catch {
    return null;
  }
}

export function isManagedWriteLockOwnerAlive(pid: unknown): boolean {
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

function hasUnsafeGitState(vault: string): boolean {
  const gitDirRaw = git(vault, ["rev-parse", "--git-dir"]);
  if (!gitDirRaw) return true;
  const gitDir = gitDirRaw.startsWith("/") ? gitDirRaw : join(vault, gitDirRaw);
  for (const rel of ["rebase-merge", "rebase-apply"]) {
    if (existsSync(join(gitDir, rel))) return true;
  }
  for (const rel of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (existsSync(join(gitDir, rel))) return true;
  }
  const unmerged = git(vault, ["ls-files", "-u"]);
  return Boolean(unmerged && unmerged.trim().length > 0);
}

/**
 * Preserve a dead-owner lock under vault-sync/recovery/ and remove the live path.
 * Never reclaims by age alone; never reclaims a live PID or unsafe git state.
 */
export function reclaimDeadManagedWriteLockOwner(vault: string): Result<{ reclaimed: boolean; recoveryPath?: string }> {
  const path = managedWriteLockPath(vault);
  if (!existsSync(path)) return ok({ reclaimed: false });

  const record = readLockRecord(path);
  if (!record) {
    // Unreadable lock: fail closed (do not delete).
    return err("SYNC_LOCK_HELD", { path, message: "managed-write lock unreadable" });
  }
  if (isManagedWriteLockOwnerAlive(record.pid)) {
    return err("SYNC_LOCK_HELD", { path, message: "managed-write lock owner is alive" });
  }
  if (hasUnsafeGitState(vault)) {
    return err("SYNC_LOCK_HELD", {
      path,
      message: "managed-write lock not reclaimed: unsafe git state",
    });
  }

  try {
    const recoveryDir = join(dirname(path), "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const recoveryPath = join(recoveryDir, `stale-managed-write-lock-${stamp}-${process.pid}.json`);
    const meta = {
      recovered_at: new Date().toISOString(),
      recovery_reason: "owner_pid_dead",
      owner_pid_alive: false,
      lock: record,
    };
    writeFileSync(recoveryPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: "wx" });
    // Remove live path only after recovery bytes are durable.
    unlinkSync(path);
    return ok({ reclaimed: true, recoveryPath });
  } catch (error: unknown) {
    return err("WRITE_FAILED", { path, message: String(error) });
  }
}

function tryCreateLock(
  path: string,
  command: string,
): Result<ManagedWriteLockHandle> {
  const ownerToken = randomBytes(16).toString("hex");
  const acquired = new Date().toISOString();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, owner_token: ownerToken, acquired, command })}\n`,
      { flag: "wx" },
    );
    return ok({ vault: "", path, ownerToken, acquired });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return err("SYNC_LOCK_HELD", { path });
    return err("WRITE_FAILED", { path, message: String(error) });
  }
}

export function acquireManagedWriteLock(vault: string, command: string): Result<ManagedWriteLockHandle> {
  const path = managedWriteLockPath(vault);

  const first = tryCreateLock(path, command);
  if (first.ok) {
    return ok({ ...first.data, vault });
  }
  if (first.error !== "SYNC_LOCK_HELD") return first;

  const reclaimed = reclaimDeadManagedWriteLockOwner(vault);
  if (!reclaimed.ok || !reclaimed.data.reclaimed) {
    return err("SYNC_LOCK_HELD", { path });
  }

  const second = tryCreateLock(path, command);
  if (second.ok) return ok({ ...second.data, vault });
  return second.ok === false ? second : err("SYNC_LOCK_HELD", { path });
}

export function releaseManagedWriteLock(handle: ManagedWriteLockHandle): Result<{ released: boolean }> {
  try {
    const parsed = JSON.parse(readFileSync(handle.path, "utf8")) as {
      owner_token?: string;
      acquired?: string;
    };
    if (parsed.owner_token !== handle.ownerToken || parsed.acquired !== handle.acquired) {
      return err("SYNC_LOCK_HELD", {
        path: handle.path,
        message: "managed-write lock ownership changed",
      });
    }
    unlinkSync(handle.path);
    return ok({ released: true });
  } catch (error: unknown) {
    return err("WRITE_FAILED", { path: handle.path, message: String(error) });
  }
}
