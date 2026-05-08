import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";

export interface IndexCheckInput { vault: string }
export interface IndexCheckOutput {
  missing_from_index: string[];
  ghost_entries: string[];
  humanHint: string;
}

export async function runIndexCheck(input: IndexCheckInput): Promise<{ exitCode: number; result: Result<IndexCheckOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  let indexText = "";
  try { indexText = await readFile(join(input.vault, "index.md"), "utf8"); } catch { /* empty */ }

  const indexSlugsLower = new Map<string, string>(); // lowercase -> original
  for (const s of extractBodyWikilinks(indexText)) {
    const tail = s.split("/").pop()!;
    indexSlugsLower.set(tail.toLowerCase(), tail);
  }
  // fileSlugs: all known pages (typed + compound) — used for ghost_entry resolution
  const fileSlugs = new Map<string, string>(); // slug -> relPath
  // requiredSlugs: pages that MUST appear in root index.md — typed knowledge only;
  // compound pages are indexed at the project level (knowledge.md), not root index.md
  const requiredSlugs = new Map<string, string>(); // slug -> relPath

  for (const p of scan.data.typedKnowledge) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    fileSlugs.set(slug, p.relPath);
    requiredSlugs.set(slug, p.relPath);
  }
  for (const p of scan.data.compound) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    fileSlugs.set(slug, p.relPath);
  }

  const missing_from_index: string[] = [];
  for (const [slug, relPath] of requiredSlugs.entries()) {
    if (!indexSlugsLower.has(slug.toLowerCase())) missing_from_index.push(relPath);
  }
  const fileSlugsLower = new Set([...fileSlugs.keys()].map(s => s.toLowerCase()));
  const ghost_entries: string[] = [];
  for (const [lower, orig] of indexSlugsLower) {
    if (!fileSlugsLower.has(lower)) ghost_entries.push(orig);
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
