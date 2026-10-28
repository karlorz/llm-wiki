import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { vaultSyncCacheDir } from "../utils/wiki-fetch-lock.js";

export interface MirrorHashState {
  version: 1;
  root: string;
  vaultId: string;
  hashes: Record<string, string>;
}
export function mirrorHashStatePath(home: string, root: string, vaultId: string): string {
  const scope = createHash("sha256").update(JSON.stringify([root, vaultId])).digest("hex");
  return join(vaultSyncCacheDir(home), "wiki-mirror", scope, "hashes.json");
}
export async function loadMirrorHashState(home: string, root: string, vaultId: string): Promise<MirrorHashState> {
  root = await realpath(root);
  const empty: MirrorHashState = { version: 1, root, vaultId, hashes: Object.create(null) };
  try {
    const raw = JSON.parse(await readFile(mirrorHashStatePath(home, root, vaultId), "utf8"));
    if (raw?.version !== 1 || raw.root !== root || raw.vaultId !== vaultId || !raw.hashes || typeof raw.hashes !== "object" || Array.isArray(raw.hashes)) return empty;
    for (const [path, hash] of Object.entries(raw.hashes)) {
      if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) empty.hashes[path] = hash;
    }
  } catch { /* Corrupt or absent state never authorizes an overwrite. */ }
  return empty;
}
export async function saveMirrorHashState(home: string, state: MirrorHashState): Promise<void> {
  const path = mirrorHashStatePath(home, state.root, state.vaultId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(() => undefined); }
}
export function priorMirrorHash(state: MirrorHashState, path: string, vaultId: string): string | undefined {
  return state.vaultId === vaultId ? state.hashes[path] : undefined;
}
