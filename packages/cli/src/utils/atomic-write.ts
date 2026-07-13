import { randomBytes } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";

export interface AtomicWriteOutput {
  changed: boolean;
  existed: boolean;
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Atomically publish text at an absolute target path, skipping identical bytes
 * so callers can avoid unnecessary mtime updates and sync activity.
 */
export async function atomicWriteText(path: string, text: string): Promise<Result<AtomicWriteOutput>> {
  let existing: string | null;
  try {
    existing = await readExisting(path);
  } catch (error: unknown) {
    return err("WRITE_FAILED", { path, phase: "read-existing", message: String(error) });
  }

  if (existing === text) return ok({ changed: false, existed: true });

  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(text, "utf8");
      try {
        await handle.sync();
      } catch {
        // Some FUSE implementations do not support fsync.
      }
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    return ok({ changed: true, existed: existing !== null });
  } catch (error: unknown) {
    try {
      await unlink(tmp);
    } catch {
      // Best-effort cleanup if the temp creation or rename failed.
    }
    return err("WRITE_FAILED", { path, phase: "atomic-write", message: String(error) });
  }
}
