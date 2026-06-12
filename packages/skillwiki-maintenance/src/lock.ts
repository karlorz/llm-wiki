import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "./types.js";

export interface MaintenanceLock {
  path: string;
  release: () => Promise<void>;
}

export interface AcquireLockOptions {
  owner: string;
  now: Date;
}

export function acquireLock(lockDir: string, options: AcquireLockOptions): Result<MaintenanceLock> {
  try {
    mkdirSync(dirname(lockDir), { recursive: true });
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      owner: options.owner,
      acquired_at: options.now.toISOString(),
      pid: process.pid,
    }, null, 2) + "\n", "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return err("LOCK_HELD", `maintenance lock is held: ${lockDir}`);
    }
    return err("LOCK_FAILED", error instanceof Error ? error.message : String(error));
  }

  return ok({
    path: lockDir,
    release: async () => {
      rmSync(lockDir, { recursive: true, force: true });
    },
  });
}
