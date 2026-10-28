import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { admitWikiMirrorPath } from "@skillwiki/shared";
import { MAX_READ_PAGE_BYTES } from "./reads.js";
import { sha256Bytes } from "../txn.js";
import type { ReconcileGate } from "../reconcile.js";

// Continuation pages reuse only discovery paths. Selected files are always
// reopened and validated below; an initial page always rebuilds the index.
const pathIndexes = new Map<string, { expires: number; paths: string[] }>();
const INDEX_TTL_MS = 30_000;
const MAX_INDEXES = 8;

export async function wikiInventory(deps: { vaultDir: string; vaultId: string; gate: ReconcileGate }, args: { after?: string; limit?: number }) {
  if (!deps.gate.ready) return { ok: false, error: "TOOLS_NOT_READY" };
  const limit = args.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (args.after !== undefined && (!admitWikiMirrorPath(args.after).ok || admitWikiMirrorPath(args.after).path !== args.after))) return { ok: false, error: "INVALID_PAGINATION" };
  let root: string;
  try { root = await realpath(deps.vaultDir); } catch { return { ok: false, error: "INVENTORY_FAILED" }; }
  let paths: string[] = [];
  let visited = 0;
  // Recheck every component, not just stale Dirents from the parent's readdir.
  async function canonicalAncestry(full: string): Promise<boolean> {
    const rel = relative(root, full);
    if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
    let cursor = root;
    for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
      if (part) cursor = join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      if (await realpath(cursor) !== cursor) return false;
    }
    return true;
  }
  async function scan(dir: string, prefix = "") {
    if (!await canonicalAncestry(dir)) return;
    const fd = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let children;
    try {
      const before = await fd.stat({ bigint: true });
      if (!await canonicalAncestry(dir)) return;
      const named = await lstat(dir, { bigint: true });
      if (named.ino !== before.ino || named.dev !== before.dev) return;
      // Linux can enumerate the pinned directory directly. Darwin has no
      // directory-fd path interface; validate ancestry again before using entries.
      children = await readdir(process.platform === "linux" ? `/proc/self/fd/${fd.fd}` : dir, { withFileTypes: true });
      const after = await lstat(dir, { bigint: true });
      if (after.ino !== before.ino || after.dev !== before.dev || !await canonicalAncestry(dir)) return;
    } finally { await fd.close(); }
    for (const entry of children) {
      if (++visited > 200_000) throw new Error("INVENTORY_TOO_LARGE");
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        try { await scan(join(dir, entry.name), `${path}/`); }
        catch (err) { if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err; }
      }
      else if (entry.isFile() && admitWikiMirrorPath(path).ok) paths.push(path);
    }
  }
  try {
    const cached = args.after ? pathIndexes.get(root) : undefined;
    if (cached && cached.expires > Date.now()) paths = cached.paths;
    else {
      await scan(root);
      paths.sort();
      for (const [key, index] of pathIndexes) if (index.expires <= Date.now()) pathIndexes.delete(key);
      if (!pathIndexes.has(root) && pathIndexes.size >= MAX_INDEXES) pathIndexes.delete(pathIndexes.keys().next().value!);
      pathIndexes.set(root, { expires: Date.now() + INDEX_TTL_MS, paths });
    }
    const entries: Array<{ path: string; sha256: string }> = [];
    let last: string | undefined;
    for (const path of paths) {
      if (args.after && path <= args.after) continue;
      if (entries.length >= limit) break;
      last = path;
      const full = join(root, path);
      try {
        const parent = join(full, "..");
        if (!await canonicalAncestry(parent) || await realpath(full) !== full) continue;
        const before = await lstat(full, { bigint: true });
        if (!before.isFile() || before.size > BigInt(MAX_READ_PAGE_BYTES)) continue;
        const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const actual = await fd.stat({ bigint: true });
          const same = (a: typeof actual, b: typeof actual) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
          if (!actual.isFile() || !same(actual, before)) continue;
          // Include one sentinel byte to detect growth without unbounded readFile.
          const bytes = Buffer.alloc(MAX_READ_PAGE_BYTES + 1);
          let length = 0;
          while (length < bytes.length) {
            const chunk = await fd.read(bytes, length, bytes.length - length, length);
            if (!chunk.bytesRead) break;
            length += chunk.bytesRead;
          }
          const after = await fd.stat({ bigint: true });
          const named = await lstat(full, { bigint: true });
          if (length > MAX_READ_PAGE_BYTES || BigInt(length) !== actual.size || !same(actual, after) || !same(after, named) || !await canonicalAncestry(parent) || await realpath(full) !== full) continue;
          entries.push({ path, sha256: sha256Bytes(bytes.subarray(0, length)) });
        } finally { await fd.close(); }
      } catch (err) { if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err; }
    }
    return { ok: true, vault_id: deps.vaultId, entries, ...(last && paths.some(path => path > last!) ? { next_after: last } : {}) };
  } catch { return { ok: false, error: "INVENTORY_FAILED" }; }
}
