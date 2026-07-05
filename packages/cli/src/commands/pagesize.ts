import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency, type PageTextCache, type VaultScan } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface PagesizeInput { vault: string; lines: number; scan?: VaultScan; pageTextCache?: PageTextCache }
export interface PagesizeOutput {
  oversized: Array<{ page: string; lines: number }>;
  humanHint: string;
}

export async function runPagesize(input: PagesizeInput): Promise<{ exitCode: number; result: Result<PagesizeOutput> }> {
  const scanResult = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };

  const perPage = await mapWithConcurrency(scanResult.data.typedKnowledge, vaultIoConcurrency(), async (p) => {
    const text = await readPageCached(p, input.pageTextCache);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const count = body.split("\n").length;
    return count > input.lines ? { page: p.relPath, lines: count } : null;
  });
  const oversized = perPage.filter((item): item is { page: string; lines: number } => item !== null);
  if (oversized.length > 0) return { exitCode: ExitCode.PAGE_TOO_LARGE, result: ok({ oversized, humanHint: oversized.map(p => `${p.page}: ${p.lines} lines`).join("\n") }) };
  return { exitCode: ExitCode.OK, result: ok({ oversized, humanHint: "all pages within size limit" }) };
}
