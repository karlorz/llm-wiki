import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";

export interface VaultPage { absPath: string; relPath: string }
export type PageTextCache = Map<string, Promise<string>>;
export interface VaultScan {
  root: string;
  allMarkdown: VaultPage[];
  typedKnowledge: VaultPage[];
  raw: VaultPage[];
  workItems: VaultPage[];
  compound: VaultPage[];
}

const TYPED_DIRS = ["entities", "concepts", "comparisons", "queries", "meta"];
const SKIP_DIRS = new Set([".git", "node_modules"]);
// FUSE mounts such as sg01's rclone wiki mount can stall under parallel reads.
const DEFAULT_IO_CONCURRENCY = 1;

export function vaultIoConcurrency(): number {
  const raw = Number.parseInt(process.env.SKILLWIKI_VAULT_IO_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 64) : DEFAULT_IO_CONCURRENCY;
}

function decodeProcMountPath(value: string): string {
  return value.replace(/\\040/g, " ");
}

function isRcloneFuseVault(root: string): boolean {
  let mounts: string;
  try {
    mounts = readFileSync("/proc/mounts", "utf8");
  } catch {
    return false;
  }
  return mounts.split(/\r?\n/).some((line) => {
    const parts = line.split(" ");
    if (parts.length < 3) return false;
    const mountPoint = decodeProcMountPath(parts[1]!);
    const fsType = parts[2]!;
    return fsType === "fuse.rclone" && (root === mountPoint || root.startsWith(`${mountPoint}/`));
  });
}

export function resolveReadOnlyVaultRoot(root: string): { root: string; mirrored: boolean } {
  if (/^(1|true|yes)$/i.test(process.env.SKILLWIKI_DISABLE_VAULT_READ_MIRROR ?? "")) {
    return { root, mirrored: false };
  }

  const explicitMirror = process.env.SKILLWIKI_VAULT_READ_MIRROR;
  if (explicitMirror && existsSync(join(explicitMirror, "SCHEMA.md"))) {
    return { root: explicitMirror, mirrored: explicitMirror !== root };
  }

  const siblingMirror = `${root}-git`;
  if (isRcloneFuseVault(root) && existsSync(join(siblingMirror, "SCHEMA.md"))) {
    return { root: siblingMirror, mirrored: true };
  }

  return { root, mirrored: false };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function scanVault(root: string): Promise<Result<VaultScan>> {
  try {
    await stat(join(root, "SCHEMA.md"));
  } catch {
    return err("VAULT_PATH_INVALID", { root, reason: "SCHEMA.md missing" });
  }
  const all = await walk(root);
  const rels = all.map(p => ({ absPath: p, relPath: relative(root, p).split(sep).join("/") }));
  return ok({
    root,
    allMarkdown: rels,
    typedKnowledge: rels.filter(p => TYPED_DIRS.some(d => p.relPath.startsWith(d + "/"))),
    raw: rels.filter(p => p.relPath.startsWith("raw/")),
    workItems: rels.filter(p => /^projects\/[^/]+\/work\/[^/]+\/(spec|plan|log)\.md$/.test(p.relPath)),
    compound: rels.filter(p => /^projects\/[^/]+\/compound\//.test(p.relPath))
  });
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  const subdirs: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      subdirs.push(p);
    }
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  const nested = await mapWithConcurrency(subdirs, Math.min(8, vaultIoConcurrency()), walk);
  for (const files of nested) out.push(...files);
  return out;
}

export async function readPage(p: VaultPage): Promise<string> {
  return readFile(p.absPath, "utf8");
}

export async function readPageCached(p: VaultPage, cache?: PageTextCache): Promise<string> {
  if (!cache) return readPage(p);
  const existing = cache.get(p.absPath);
  if (existing) return existing;
  const pending = readPage(p);
  cache.set(p.absPath, pending);
  return pending;
}
