import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
