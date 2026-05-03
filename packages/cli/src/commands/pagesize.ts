import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface PagesizeInput { vault: string; lines: number }
export interface PagesizeOutput {
  oversized: Array<{ page: string; lines: number }>;
}

export async function runPagesize(input: PagesizeInput): Promise<{ exitCode: number; result: Result<PagesizeOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const oversized: PagesizeOutput["oversized"] = [];
  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const count = body.split("\n").length;
    if (count > input.lines) oversized.push({ page: p.relPath, lines: count });
  }
  if (oversized.length > 0) return { exitCode: ExitCode.PAGE_TOO_LARGE, result: ok({ oversized }) };
  return { exitCode: ExitCode.OK, result: ok({ oversized }) };
}
