import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Validate every component, then open the leaf without following links. */
export async function readRegular(root: string, path: string, maxBytes: number): Promise<Buffer> {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("unsafe input path");
  let current = resolve(root);
  for (const part of ["", ...rel.split(sep)]) {
    current = resolve(current, part);
    const st = await lstat(current);
    if (st.isSymbolicLink()) throw new Error("symlink input refused");
    if (current !== path && !st.isDirectory()) throw new Error("invalid input parent");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("input type or size refused");
    const bytes = Buffer.alloc(before.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const after = await handle.stat();
    // Catch a parent symlink/identity swap after the no-follow open.
    if (await realpath(path) !== path) throw new Error("input path changed during read");
    const leaf = await lstat(path);
    if (leaf.ino !== before.ino || leaf.dev !== before.dev) throw new Error("input identity changed during read");
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("input changed during read");
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** Create-only write under root. Same bytes are idempotent; different bytes never overwrite. */
export async function writeRegularExclusive(root: string, rel: string, body: Buffer): Promise<"created" | "idempotent" | "conflict"> {
  const dest = resolve(root, ...rel.split("/"));
  const checked = relative(root, dest);
  if (!checked || checked.startsWith(`..${sep}`) || checked === ".." || isAbsolute(checked)) throw new Error("unsafe dest path");
  let current = resolve(root);
  const parts = checked.split(sep);
  for (let i = 0; i < parts.length - 1; i++) {
    current = resolve(current, parts[i]!);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) throw new Error("symlink dest refused");
      if (!st.isDirectory()) throw new Error("invalid dest parent");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }
  const leaf = resolve(current, parts[parts.length - 1]!);
  if (dirname(leaf) !== current) throw new Error("unsafe dest path");
  try {
    const handle = await open(leaf, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(body); } finally { await handle.close(); }
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const st = await lstat(leaf);
    if (st.isSymbolicLink() || !st.isFile() || st.size !== body.length) return "conflict";
    const existing = await readRegular(root, leaf, body.length);
    return existing.equals(body) ? "idempotent" : "conflict";
  }
}
