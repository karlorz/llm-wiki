import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { buildRootIndexUniverse } from "../utils/index-universe.js";
import type { VaultScan } from "../utils/vault.js";
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
  const universe = await buildRootIndexUniverse({ vault: input.vault, scan: input.scan });
  if (!universe.ok) {
    const exitCode = universe.error === "VAULT_PATH_INVALID"
      ? ExitCode.VAULT_PATH_INVALID
      : ExitCode.SCHEME_REJECTED;
    return { exitCode, result: universe };
  }

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
  for (const entry of universe.data.required) {
    required.set(entry.target, `${entry.target}.md`);
  }
  const requiredBasenameCounts = new Map<string, number>();
  for (const target of required.keys()) {
    const basename = target.split("/").pop()!.toLowerCase();
    requiredBasenameCounts.set(basename, (requiredBasenameCounts.get(basename) ?? 0) + 1);
  }
  const known = universe.data.knownTargets;

  const missing_from_index: string[] = [];
  for (const [target, relPath] of required.entries()) {
    if (indexTargets.has(target)) continue;
    // Accept a unique basename-only index link for backward compatibility.
    const bare = target.split("/").pop()!.toLowerCase();
    const bareHits = indexBare.get(bare) ?? [];
    const basenameOnly = bareHits.filter((t) => !t.includes("/"));
    if (basenameOnly.length === 1 && requiredBasenameCounts.get(bare) === 1) continue;
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
