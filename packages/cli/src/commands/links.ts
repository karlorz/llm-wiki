import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface LinksInput { vault: string }
export interface LinksOutput {
  broken: Array<{ page: string; slug: string; line: number }>;
}

export async function runLinks(input: LinksInput): Promise<{ exitCode: number; result: Result<LinksOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const slugs = new Set<string>();
  for (const p of scan.data.typedKnowledge) {
    slugs.add(p.relPath.replace(/\.md$/, "").split("/").pop()!);
  }

  const broken: LinksOutput["broken"] = [];
  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const lines = body.split("\n");
    for (const slug of extractBodyWikilinks(body)) {
      const tail = slug.split("/").pop()!;
      if (!slugs.has(tail)) {
        const line = lines.findIndex(l => l.includes(`[[${slug}`));
        broken.push({ page: p.relPath, slug, line: line >= 0 ? line + 1 : 0 });
      }
    }
  }
  if (broken.length > 0) {
    return { exitCode: ExitCode.BROKEN_WIKILINKS, result: ok({ broken }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ broken }) };
}
