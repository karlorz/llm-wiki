import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";
import { safeWritePage } from "../utils/safe-write.js";

export interface FrontmatterFixInput {
  vault: string;
  dryRun: boolean;
}

export interface FrontmatterFixOutput {
  scanned: number;
  fixed: string[];
  skipped: string[];
  unchanged: number;
  humanHint: string;
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function fixFrontmatter(rawFm: string): string {
  const additions: string[] = [];

  // Add missing fields (rawFm is the YAML between --- delimiters, no --- itself)
  if (!/^created:/m.test(rawFm)) additions.push(`created: ${isoToday()}`);
  if (!/^updated:/m.test(rawFm)) additions.push(`updated: ${isoToday()}`);
  if (!/^tags:/m.test(rawFm)) additions.push("tags: []");
  if (!/^sources:/m.test(rawFm)) additions.push("sources: []");
  if (!/^provenance:/m.test(rawFm)) additions.push("provenance: research");

  if (additions.length === 0) return rawFm;
  return rawFm.trimEnd() + "\n" + additions.join("\n") + "\n";
}

function removeOrphanTagsLines(body: string): string {
  // Remove orphan "tags:" lines in body (left by Python fix scripts)
  // These are lines that start with "tags:" but are NOT inside frontmatter
  return body
    .split("\n")
    .filter(line => !/^tags:\s*\[/.test(line.trim()))
    .join("\n");
}

export async function runFrontmatterFix(input: FrontmatterFixInput): Promise<{ exitCode: number; result: Result<FrontmatterFixOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const fixed: string[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  for (const page of scan.data.typedKnowledge) {
    const text = await readPage(page);
    const split = splitFrontmatter(text);
    if (!split.ok) { skipped.push(page.relPath); continue; }

    const { rawFrontmatter, body } = split.data;

    const newFm = fixFrontmatter(rawFrontmatter);
    const newBody = removeOrphanTagsLines(body);
    const newText = `---\n${newFm}\n---\n${newBody}`;

    if (newText === text) { unchanged++; continue; }

    if (!input.dryRun) {
      const w = await safeWritePage(page.absPath, newText);
      if (!w.ok) { skipped.push(page.relPath); continue; }
    }
    fixed.push(page.relPath);
  }

  const exitCode = fixed.length > 0 ? ExitCode.MIGRATION_APPLIED : ExitCode.OK;
  const hintLines = [`scanned: ${fixed.length + skipped.length + unchanged}`];
  if (fixed.length > 0) hintLines.push(`fixed: ${fixed.length}`);
  if (skipped.length > 0) hintLines.push(`skipped (parse error): ${skipped.length}`);
  if (unchanged > 0) hintLines.push(`unchanged: ${unchanged}`);
  if (input.dryRun && fixed.length > 0) hintLines.push("(dry run — no files written)");

  if (!input.dryRun && fixed.length > 0) {
    appendLastOp(input.vault, {
      operation: "frontmatter-fix",
      summary: `normalized frontmatter on ${fixed.length} page(s)`,
      files: fixed,
      timestamp: new Date().toISOString(),
    });
  }

  return {
    exitCode,
    result: ok({
      scanned: fixed.length + skipped.length + unchanged,
      fixed,
      skipped,
      unchanged,
      humanHint: hintLines.join("\n")
    })
  };
}
