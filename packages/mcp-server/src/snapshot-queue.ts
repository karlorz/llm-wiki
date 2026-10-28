import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SnapshotConfig { stateDir: string; vaultId: string }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function safeSnapshotState(config: SnapshotConfig, vaultRoots: string[]): string {
  if (!isAbsolute(config.stateDir)) throw new Error("UNSAFE_SNAPSHOT_STATE");
  const root = resolve(config.stateDir);
  const directoryOrMissing = (path: string) => {
    try {
      const stat = lstatSync(path); // existsSync follows dangling symlinks.
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("UNSAFE_SNAPSHOT_STATE");
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  };
  // Resolve every live root too: a lexical alias can hide physical containment.
  for (const vault of vaultRoots.map(vault => realpathSync(vault))) {
    const rel = relative(resolve(vault), root);
    const inverse = relative(root, resolve(vault));
    if ((!rel.startsWith(`..${sep}`) && rel !== "..") || (!inverse.startsWith(`..${sep}`) && inverse !== "..")) throw new Error("UNSAFE_SNAPSHOT_STATE");
  }
  let cursor = root;
  while (true) {
    directoryOrMissing(cursor);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of ["pending", "running", "receipts"]) {
    const path = join(root, name);
    directoryOrMissing(path);
    mkdirSync(path, { mode: 0o700, recursive: true });
  }
  return root;
}
export class SnapshotQueue {
  private lastError?: string;
  constructor(readonly config: SnapshotConfig, private readonly vaultRoots: string[]) {}
  request(vaultId: string) {
    if (vaultId !== "central" || this.config.vaultId !== "central") return { ok: false, vault_id: vaultId, state: "disabled" as const };
    try {
      const root = safeSnapshotState(this.config, this.vaultRoots);
      const request_id = randomUUID();
      const record = { request_id, vault_id: vaultId, state: "queued", created_at: Date.now(), attempt: 0, next_attempt: 0 };
      const temp = join(root, "pending", `.${request_id}.tmp`);
      const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, join(root, "pending", `${request_id}.json`));
      const dir = openSync(join(root, "pending"), constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
      this.lastError = undefined;
      return { ok: true, vault_id: vaultId, state: "queued" as const, request_id };
    } catch { console.error("skillwiki-mcp snapshot enqueue failed"); this.lastError = "SNAPSHOT_ENQUEUE_FAILED"; return { ok: false, vault_id: vaultId, state: "failed" as const, error: this.lastError }; }
  }
  status(vaultId: string, requestId?: string) {
    if (vaultId !== "central" || this.config.vaultId !== "central") return { ok: false, vault_id: vaultId, state: "disabled" };
    if (requestId && !ID.test(requestId)) return { ok: false, vault_id: vaultId, state: "failed", error: "INVALID_REQUEST_ID" };
    try {
      const root = safeSnapshotState(this.config, this.vaultRoots);
      if (!requestId) return { ok: !this.lastError, vault_id: vaultId, state: this.lastError ? "failed" : "unknown", ...(this.lastError ? { error: this.lastError } : {}) };
      // Active retry claims take precedence over the retained failed receipt.
      for (const area of ["running", "receipts", "pending"]) {
        const path = join(root, area, `${requestId}.json`);
        try {
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let rec; try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 16384) throw new Error("invalid record"); rec = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
          if (rec.request_id !== requestId || rec.vault_id !== vaultId) throw new Error("invalid record");
          return { ...rec, ok: rec.state !== "failed" };
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
      }
      return { ok: true, vault_id: vaultId, state: "unknown", request_id: requestId };
    } catch { return { ok: false, vault_id: vaultId, state: "failed", error: "SNAPSHOT_STATUS_FAILED" }; }
  }
}
