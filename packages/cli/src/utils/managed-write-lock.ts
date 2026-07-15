import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { git } from "./git.js";

export interface ManagedWriteLockHandle {
  vault: string;
  path: string;
  ownerToken: string;
  acquired: string;
}

export function managedWriteLockPath(vault: string): string {
  const gitPath = git(vault, ["rev-parse", "--git-path", "vault-sync/managed-write.lock"]);
  if (gitPath) return gitPath.startsWith("/") ? gitPath : join(vault, gitPath);
  return join(vault, ".skillwiki", "managed-write.lock");
}

export function acquireManagedWriteLock(vault: string, command: string): Result<ManagedWriteLockHandle> {
  const path = managedWriteLockPath(vault);
  const ownerToken = randomBytes(16).toString("hex");
  const acquired = new Date().toISOString();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, owner_token: ownerToken, acquired, command })}\n`,
      { flag: "wx" },
    );
    return ok({ vault, path, ownerToken, acquired });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return err("SYNC_LOCK_HELD", { path });
    return err("WRITE_FAILED", { path, message: String(error) });
  }
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
