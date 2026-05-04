import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface StaleInput { vault: string; days: number }
export interface StaleOutput {
  stale: Array<{ page: string; page_updated: string; newest_source_ingested: string; gap_days: number }>;
  humanHint: string;
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  return Math.round((db - da) / 86400000);
}

export async function runStale(input: StaleInput): Promise<{ exitCode: number; result: Result<StaleOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const stale: StaleOutput["stale"] = [];

  for (const p of scan.data.typedKnowledge) {
    const fm = extractFrontmatter(await readPage(p));
    if (!fm.ok) continue;
    const updated = typeof fm.data.updated === "string" ? fm.data.updated : undefined;
    const sources = Array.isArray(fm.data.sources) ? fm.data.sources.filter((s): s is string => typeof s === "string") : [];
    if (!updated || sources.length === 0) continue;

    let newest: string | undefined;
    for (const rel of sources) {
      let raw: string;
      try { raw = await readFile(join(input.vault, rel), "utf8"); } catch { continue; }
      const rfm = extractFrontmatter(raw);
      if (!rfm.ok) continue;
      const ing = typeof rfm.data.ingested === "string" ? rfm.data.ingested : undefined;
      if (ing && (!newest || Date.parse(ing) > Date.parse(newest))) newest = ing;
    }
    if (!newest) continue;
    const gap = dayDiff(updated, newest);
    if (gap > input.days) {
      stale.push({ page: p.relPath, page_updated: updated, newest_source_ingested: newest, gap_days: gap });
    }
  }

  if (stale.length > 0) return { exitCode: ExitCode.STALE_PAGE, result: ok({ stale, humanHint: stale.map(s => `${s.page} (${s.gap_days}d stale)`).join("\n") }) };
  return { exitCode: ExitCode.OK, result: ok({ stale, humanHint: "no stale pages" }) };
}
