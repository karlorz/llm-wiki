import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";

export interface VaultPage { absPath: string; relPath: string }
export interface VaultScan {
  root: string;
  typedKnowledge: VaultPage[];
  raw: VaultPage[];
  workItems: VaultPage[];
  compound: VaultPage[];
}

const TYPED_DIRS = ["entities", "concepts", "comparisons", "queries", "meta"];

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
    typedKnowledge: rels.filter(p => TYPED_DIRS.some(d => p.relPath.startsWith(d + "/"))),
    raw: rels.filter(p => p.relPath.startsWith("raw/")),
    workItems: rels.filter(p => /^projects\/[^/]+\/work\/[^/]+\/(spec|plan|log)\.md$/.test(p.relPath)),
    compound: rels.filter(p => /^projects\/[^/]+\/compound\//.test(p.relPath))
  });
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export async function readPage(p: VaultPage): Promise<string> {
  return readFile(p.absPath, "utf8");
}
