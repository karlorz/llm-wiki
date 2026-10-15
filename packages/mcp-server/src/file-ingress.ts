import { timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sha256Token } from "./auth.js";
import type { GetObject } from "./versions.js";
import { sha256Bytes, withWriteMutex, writeAtomicPath } from "./txn.js";
import { DEFAULT_VAULT_ID } from "./vault-id.js";

const relPath = z.string().regex(/^raw\/(articles|assets)\/[A-Za-z0-9._/-]+$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const ReadyHintSchema = z.object({
  vault_id: z.string().min(1).max(64),
  files: z.array(z.object({
    path: relPath,
    sha256: sha256Hex,
  }).strict()).min(1).max(80),
}).strict();

export type ReadyHint = z.infer<typeof ReadyHintSchema>;

export function orderIngressPaths(paths: string[]): string[] {
  const assets = paths.filter((p) => p.startsWith("raw/assets/"));
  const articles = paths.filter((p) => p.startsWith("raw/articles/"));
  return [...assets, ...articles];
}

export function fileIngressTokenMatches(token: string, expectedSha256Hex: string): boolean {
  const digest = sha256Token(token);
  const expected = Buffer.from(expectedSha256Hex, "hex");
  if (digest.length !== expected.length) return false;
  return timingSafeEqual(digest, expected);
}

export interface AdoptDeps {
  vaultDir: string;
  vaultId?: string;
  getObject: GetObject;
  isTombstoned?: (path: string) => Promise<boolean> | boolean;
  emitChanged: (paths: string[], vaultId?: string) => void;
}

export type AdoptResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: string; status: number };

export async function adoptReadyHint(hint: ReadyHint, deps: AdoptDeps): Promise<AdoptResult> {
  const vaultId = hint.vault_id || deps.vaultId || DEFAULT_VAULT_ID;
  return withWriteMutex(() => adoptReadyHintLocked(hint, deps, vaultId), vaultId);
}

async function adoptReadyHintLocked(hint: ReadyHint, deps: AdoptDeps, vaultId: string): Promise<AdoptResult> {
  const ordered = orderIngressPaths(hint.files.map((f) => f.path));
  const byPath = new Map(hint.files.map((f) => [f.path, f.sha256]));
  const adopted: string[] = [];

  for (const path of ordered) {
    if (await deps.isTombstoned?.(path)) {
      return { ok: false, error: "tombstoned", status: 409 };
    }
    const expected = byPath.get(path);
    if (!expected) continue;
    const obj = await deps.getObject(path);
    const body = obj?.body;
    if (!body) return { ok: false, error: `missing object ${path}`, status: 409 };
    if (sha256Bytes(body) !== expected) {
      return { ok: false, error: `hash mismatch ${path}`, status: 409 };
    }
    const dest = join(deps.vaultDir, path);
    let existing: Buffer | undefined;
    try {
      existing = await readFile(dest);
    } catch { /* absent */ }
    if (existing) {
      if (sha256Bytes(existing) !== expected) {
        return { ok: false, error: `local conflict ${path}`, status: 409 };
      }
    } else {
      await writeAtomicPath(dest, body);
    }
    adopted.push(path);
  }

  const orderedAdopted = orderIngressPaths(adopted);
  const article = orderedAdopted.filter((p) => p.startsWith("raw/articles/"));
  const assets = orderedAdopted.filter((p) => p.startsWith("raw/assets/"));
  if (article.length > 0 && assets.length === 0 && hint.files.some((f) => f.path.startsWith("raw/assets/"))) {
    return { ok: false, error: "article without adopted assets", status: 409 };
  }
  deps.emitChanged(orderedAdopted, vaultId);
  return { ok: true, paths: orderedAdopted };
}

export function scanCopiedRaw(opts: {
  files: Array<{ path: string; sha256: string }>;
  seen: Map<string, string>;
}): string[] {
  const fresh: string[] = [];
  for (const file of opts.files) {
    if (opts.seen.get(file.path) === file.sha256) continue;
    fresh.push(file.path);
    opts.seen.set(file.path, file.sha256);
  }
  return orderIngressPaths(fresh);
}

export async function persistSeen(stateFile: string, seen: Map<string, string>): Promise<void> {
  const payload = JSON.stringify(Object.fromEntries(seen));
  try {
    if ((await readFile(stateFile, "utf8")) === payload) return;
  } catch {
    /* missing */
  }
  await writeAtomicPath(stateFile, payload);
}

async function walkRaw(vaultDir: string, prefix: "raw/articles" | "raw/assets"): Promise<Array<{ path: string; sha256: string }>> {
  const root = join(vaultDir, prefix);
  const out: Array<{ path: string; sha256: string }> = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRel = rel ? `${rel}/${entry.name}` : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, nextRel);
      } else if (entry.isFile()) {
        const body = await readFile(abs);
        out.push({ path: nextRel, sha256: sha256Bytes(body) });
      }
    }
  }
  await walk(root, prefix);
  return out;
}

export async function emitNewRawAfterCopy(opts: {
  vaultDir: string;
  vaultId: string;
  emitChanged: (paths: string[], vaultId?: string) => void;
  seenFile?: string;
}): Promise<string[]> {
  const seenFile = opts.seenFile ?? join(opts.vaultDir, ".skillwiki", "clip-ingress-seen.json");
  let seen = new Map<string, string>();
  try {
    const raw = JSON.parse(await readFile(seenFile, "utf8")) as Record<string, string>;
    seen = new Map(Object.entries(raw));
  } catch { /* first run */ }
  const firstRun = seen.size === 0;
  const files = [
    ...(await walkRaw(opts.vaultDir, "raw/articles")),
    ...(await walkRaw(opts.vaultDir, "raw/assets")),
  ];
  const fresh = scanCopiedRaw({ files, seen });
  await persistSeen(seenFile, seen);
  if (firstRun || fresh.length === 0) return [];
  opts.emitChanged(fresh, opts.vaultId);
  return fresh;
}
