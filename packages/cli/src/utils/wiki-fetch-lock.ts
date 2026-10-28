import { mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function vaultSyncCacheDir(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Caches", "vault-sync");
  return join(home, ".cache", "vault-sync");
}

/** Directory mutex compatible with wiki-fetch-notify / wiki-pull `pull.lock.d`. */
export function wikiFetchPullLockDir(home: string): string {
  return join(vaultSyncCacheDir(home), "wiki-fetch", "pull.lock.d");
}

export async function acquireWikiFetchPullLock(home: string): Promise<(() => Promise<void>) | null> {
  const lockDir = wikiFetchPullLockDir(home);
  await mkdir(dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  return async () => {
    await rmdir(lockDir).catch(() => undefined);
  };
}
