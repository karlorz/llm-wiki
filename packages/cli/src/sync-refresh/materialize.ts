import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, linkSync, renameSync, unlinkSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse, resolve, sep } from "node:path";
import { admitWikiMirrorPath, type WikiMirrorFamily } from "@skillwiki/shared";
import { gitHeadBytes } from "./github-state.js";

export type MaterializeDecision = "created" | "idempotent" | "replaced" | "conflict" | "denied";
export interface MaterializeResult { decision: MaterializeDecision; reason?: string; localSha256?: string }
export function sha256Buffer(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function fail(reason: string): never { throw new Error(reason); }
const fold = (name: string) => name.normalize("NFC").toLowerCase();
function noCaseCollision(parent: string, name: string): void {
  if (readdirSync(parent).some(entry => entry !== name && fold(entry) === fold(name))) fail("CASE_COLLISION");
}
/** Check the root's ancestors too: realpath equality alone misses a symlink root on some platforms. */
export function assertFrozenMirror(root: string): string {
  root = resolve(root);
  let current = parse(root).root;
  for (const part of root.slice(current.length).split(sep).filter(Boolean)) {
    noCaseCollision(current, part);
    current = join(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) fail("SYMLINK_OR_INVALID_ROOT");
  }
  const marker = lstatSync(join(root, ".WIKI_GIT_FROZEN"));
  if (!marker.isFile() || marker.isSymbolicLink()) fail("FROZEN_MARKER_REQUIRED");
  return realpathSync(root);
}
function safeLeaf(root: string, rel: string, createParents: boolean): string {
  assertFrozenMirror(root);
  let parent = root;
  const parts = rel.split("/");
  for (const part of parts.slice(0, -1)) {
    noCaseCollision(parent, part);
    parent = join(parent, part);
    if (!existsSync(parent) && createParents) mkdirSync(parent);
    const st = lstatSync(parent);
    if (st.isSymbolicLink() || !st.isDirectory()) fail("SYMLINK_OR_INVALID_PARENT");
  }
  const name = parts.at(-1)!;
  noCaseCollision(parent, name);
  const leaf = join(parent, name);
  try {
    const st = lstatSync(leaf);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) fail("SYMLINK_OR_INVALID_FILE");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return leaf;
}
export function decideMaterialize(input: { family: WikiMirrorFamily; local: Buffer | null; incoming: Buffer; priorHash?: string; gitHead?: Buffer | null }): Exclude<MaterializeDecision, "denied"> {
  if (!input.local) return "created";
  const localHash = sha256Buffer(input.local);
  if (localHash === sha256Buffer(input.incoming)) return "idempotent";
  if (input.family === "raw") return "conflict";
  if (input.priorHash === localHash || (input.gitHead && sha256Buffer(input.gitHead) === localHash)) return "replaced";
  return "conflict";
}
/** A discovery hint only: validate admission, ancestry and a no-follow local read.
 * This does not establish current S3 verification or authorize replacement.
 */
export function localMirrorMatches(vault: string, rel: string, hash: string): boolean {
  if (!admitWikiMirrorPath(rel).ok || !/^[a-f0-9]{64}$/.test(hash)) return false;
  let fd: number | undefined;
  try {
    const leaf = safeLeaf(assertFrozenMirror(vault), rel, false);
    fd = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd), now = lstatSync(leaf);
    if (!st.isFile() || st.nlink !== 1 || st.ino !== now.ino || st.dev !== now.dev) return false;
    const matches = sha256Buffer(readFileSync(fd)) === hash;
    safeLeaf(vault, rel, false);
    const final = lstatSync(leaf);
    return matches && final.ino === st.ino && final.dev === st.dev;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Caller holds the cooperative pull mutex. Final checks and publication do not yield.
 * Rename is atomic publication, not an OS compare-and-swap against hostile writers.
 */
export async function materializeAdmittedPage(input: { vault: string; rel: string; body: Buffer; priorHash?: string }): Promise<MaterializeResult> {
  // Directory fsync and no-follow publication are required, not optional.
  // Refuse before creating parents or staging bytes on unsupported Windows.
  if (process.platform === "win32") return { decision: "denied", reason: "UNSUPPORTED_PLATFORM" };
  const admitted = admitWikiMirrorPath(input.rel);
  if (!admitted.ok) return { decision: "denied", reason: admitted.reason };
  let fd: number | undefined, tempFd: number | undefined, temp: string | undefined;
  try {
    const root = assertFrozenMirror(input.vault);
    const leaf = safeLeaf(root, admitted.path, true);
    let local: Buffer | null = null;
    try {
      fd = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) fail("INVALID_FILE");
      local = readFileSync(fd);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const decision = decideMaterialize({ family: admitted.family, local, incoming: input.body, priorHash: input.priorHash,
      gitHead: admitted.family === "maintained" ? gitHeadBytes(root, admitted.path) : null });
    if (decision === "conflict") return { decision, localSha256: sha256Buffer(local!), reason: "LOCAL_CONFLICT" };
    if (decision !== "idempotent") {
      temp = join(dirname(leaf), `.wiki-mirror-${randomUUID()}.tmp`);
      tempFd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, fd === undefined ? 0o644 : fstatSync(fd).mode & 0o777);
      let offset = 0;
      while (offset < input.body.length) {
        const written = writeSync(tempFd, input.body, offset, input.body.length - offset, offset);
        if (!written) fail("SHORT_WRITE");
        offset += written;
      }
      fsyncSync(tempFd);
    }
    // Recheck ancestry, inode and complete base bytes immediately before publication.
    safeLeaf(root, admitted.path, false);
    if (fd !== undefined) {
      const st = fstatSync(fd), now = lstatSync(leaf);
      if (now.ino !== st.ino || now.dev !== st.dev || realpathSync(leaf) !== leaf) fail("LOCAL_CHANGED");
      const check = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const checked = fstatSync(check);
        if (checked.ino !== st.ino || checked.dev !== st.dev || !readFileSync(check).equals(local!)) fail("LOCAL_CHANGED");
      } finally { closeSync(check); }
    }
    if (decision !== "idempotent") {
      const staged = fstatSync(tempFd!), stagedPath = lstatSync(temp!);
      if (staged.ino !== stagedPath.ino || staged.dev !== stagedPath.dev || stagedPath.isSymbolicLink() || staged.nlink !== 1) fail("TEMP_CHANGED");
      if (decision === "created") {
        // link is exclusive and exposes only fully written, synced bytes.
        linkSync(temp!, leaf);
        unlinkSync(temp!);
      } else renameSync(temp!, leaf);
      temp = undefined;
      const parentFd = openSync(dirname(leaf), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    }
    safeLeaf(root, admitted.path, false);
    const verify = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!readFileSync(verify).equals(input.body)) fail("POSTWRITE_HASH_MISMATCH");
      const st = fstatSync(verify), original = fstatSync(tempFd ?? fd!);
      if (st.ino !== original.ino || st.dev !== original.dev) fail("LOCAL_CHANGED");
    } finally { closeSync(verify); }
    return { decision, localSha256: sha256Buffer(input.body) };
  } catch (error) { return { decision: "denied", reason: error instanceof Error ? error.message : "WRITE_FAILED" }; }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (tempFd !== undefined) closeSync(tempFd);
    if (temp !== undefined) { try { unlinkSync(temp); } catch { /* Publication failed; best effort cleanup. */ } }
  }
}
