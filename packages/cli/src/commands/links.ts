import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency, type PageTextCache, type VaultScan } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { buildSlugMap } from "../utils/slug.js";

export interface LinksInput { vault: string; scan?: VaultScan; pageTextCache?: PageTextCache }
export interface LinksOutput {
  broken: Array<{ page: string; slug: string; line: number }>;
  humanHint: string;
}

export async function runLinks(input: LinksInput): Promise<{ exitCode: number; result: Result<LinksOutput> }> {
  const scanResult = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };
  const scan = scanResult.data;

  const allPages = [...scan.typedKnowledge, ...scan.raw, ...scan.workItems, ...scan.compound];
  const slugs = buildSlugMap(allPages);

  const perPage = await mapWithConcurrency(scan.typedKnowledge, vaultIoConcurrency(), async (p) => {
    const text = await readPageCached(p, input.pageTextCache);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const lines = body.split("\n");
    const broken: LinksOutput["broken"] = [];
    for (const slug of extractBodyWikilinks(body)) {
      const tail = slug.split("/").pop()!.replace(/\.md$/, "");
      if (!slugs.has(tail.toLowerCase())) {
        const line = lines.findIndex(l => l.includes(`[[${slug}`));
        broken.push({ page: p.relPath, slug, line: line >= 0 ? line + 1 : 0 });
      }
    }
    return broken;
  });
  const broken = perPage.flat();
  if (broken.length > 0) {
    return { exitCode: ExitCode.BROKEN_WIKILINKS, result: ok({ broken, humanHint: `broken: ${broken.length}\n${broken.map(b => `  ${b.page}:[[${b.slug}]] (line ${b.line})`).join("\n")}` }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ broken, humanHint: "no broken wikilinks" }) };
}
