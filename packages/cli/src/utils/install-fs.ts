import { copyFile, mkdir, rename, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";

export interface CopyResult { copied: true; backupPath: string | null }

export async function atomicCopyWithBackup(src: string, dst: string): Promise<Result<CopyResult>> {
  await mkdir(dirname(dst), { recursive: true });
  let backupPath: string | null = null;
  try {
    await stat(dst);
    backupPath = `${dst}.bak`;
    await copyFile(dst, backupPath);
  } catch { /* target absent, no backup */ }
  const tmp = `${dst}.tmp.${process.pid}`;
  try {
    await copyFile(src, tmp);
    await rename(tmp, dst);
  } catch (e) {
    return err("ATOMIC_COPY_FAILED", { message: String(e) });
  }
  return ok({ copied: true, backupPath });
}

export interface SkillMeta {
  name: string;
  version?: string;
  deprecated?: boolean;
}

export interface Manifest {
  installed: string[];
  backed_up: string[];
  installed_at?: string;
  version?: string;
  symlink?: boolean;
  skills?: Record<string, SkillMeta>;
}

export async function writeManifest(path: string, m: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const enriched: Manifest = { installed_at: new Date().toISOString(), ...m };
  await writeFile(path, JSON.stringify(enriched, null, 2));
}
