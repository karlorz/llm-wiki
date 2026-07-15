import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, type VaultScan } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";

export interface IndexCheckInput { vault: string; scan?: VaultScan }
export interface IndexCheckOutput {
  missing_from_index: string[];
  ghost_entries: string[];
  humanHint: string;
}

function normalizeIndexTarget(raw: string): string {
  return raw.replace(/\.md$/, "").replace(/^\.?\//, "");
}

export async function runIndexCheck(input: IndexCheckInput): Promise<{ exitCode: number; result: Result<IndexCheckOutput> }> {
  const scan = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  let indexText = "";
  try { indexText = await readFile(join(input.vault, "index.md"), "utf8"); } catch { /* empty */ }

  // Full canonical targets from index (path-aware). Basename-only links are
  // retained as secondary keys only when unique among required pages.
  const indexTargets = new Set<string>();
  const indexBare = new Map<string, string[]>(); // lowercase basenames -> raw targets
  for (const s of extractBodyWikilinks(indexText)) {
    const target = normalizeIndexTarget(s);
    indexTargets.add(target);
    const bare = target.split("/").pop()!.toLowerCase();
    const list = indexBare.get(bare) ?? [];
    list.push(target);
    indexBare.set(bare, list);
  }

  const required = new Map<string, string>(); // full target no-ext -> relPath
  const known = new Set<string>(); // all known no-ext paths for ghost resolution

  for (const p of scan.data.typedKnowledge) {
    const target = p.relPath.replace(/\.md$/, "");
    required.set(target, p.relPath);
    known.add(target);
  }
  for (const p of scan.data.compound) {
    known.add(p.relPath.replace(/\.md$/, ""));
  }

  const missing_from_index: string[] = [];
  for (const [target, relPath] of required.entries()) {
    if (indexTargets.has(target)) continue;
    // Accept a unique basename-only index link for backward compatibility.
    const bare = target.split("/").pop()!.toLowerCase();
    const bareHits = indexBare.get(bare) ?? [];
    const basenameOnly = bareHits.filter((t) => !t.includes("/"));
    const sameNameRequired = [...required.keys()].filter(
      (t) => t.split("/").pop()!.toLowerCase() === bare,
    );
    if (basenameOnly.length === 1 && sameNameRequired.length === 1) continue;
    missing_from_index.push(relPath);
  }

  const ghost_entries: string[] = [];
  for (const target of indexTargets) {
    if (known.has(target)) continue;
    if (!target.includes("/")) {
      // basename-style: ghost only if no known page ends with that basename
      const bare = target.toLowerCase();
      const matches = [...known].filter((k) => k.split("/").pop()!.toLowerCase() === bare);
      if (matches.length === 0) ghost_entries.push(target);
      continue;
    }
    ghost_entries.push(target);
  }

  const hintLines: string[] = [];
  if (missing_from_index.length > 0) hintLines.push(`missing from index: ${missing_from_index.length}`, ...missing_from_index.map(p => `  ${p}`));
  if (ghost_entries.length > 0) hintLines.push(`ghost entries: ${ghost_entries.length}`, ...ghost_entries.map(g => `  ${g}`));
  if (hintLines.length === 0) hintLines.push("index OK");

  if (missing_from_index.length > 0 || ghost_entries.length > 0) {
    return { exitCode: ExitCode.INDEX_INCOMPLETE, result: ok({ missing_from_index, ghost_entries, humanHint: hintLines.join("\n") }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ missing_from_index, ghost_entries, humanHint: hintLines.join("\n") }) };
}
