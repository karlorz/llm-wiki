import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface OverlapInput { vault: string }
export interface OverlapCluster { id: string; members: string[]; score: number }
export interface OverlapOutput { clusters: OverlapCluster[]; humanHint: string }

export async function runOverlap(input: OverlapInput): Promise<{ exitCode: number; result: Result<OverlapOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const sourcesByPage: Record<string, Set<string>> = {};
  for (const p of scan.data.typedKnowledge) {
    const fm = extractFrontmatter(await readPage(p));
    if (!fm.ok) continue;
    const srcs = (fm.data.sources as string[] | undefined) ?? [];
    sourcesByPage[p.relPath] = new Set(srcs);
  }

  // Union-find over pages that share any source.
  const parent: Record<string, string> = {};
  for (const k of Object.keys(sourcesByPage)) parent[k] = k;
  const find = (x: string): string => parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const pages = Object.keys(sourcesByPage);
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const sa = sourcesByPage[pages[i]], sb = sourcesByPage[pages[j]];
      const shared = [...sa].filter(x => sb.has(x)).length;
      if (shared > 0) union(pages[i], pages[j]);
    }
  }

  const groups: Record<string, string[]> = {};
  for (const p of pages) {
    const r = find(p);
    (groups[r] ??= []).push(p);
  }
  const clusters: OverlapCluster[] = Object.entries(groups)
    .filter(([, m]) => m.length > 1)
    .map(([id, members]) => {
      let score = 0;
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++) {
          const sa = sourcesByPage[members[i]], sb = sourcesByPage[members[j]];
          score += [...sa].filter(x => sb.has(x)).length;
        }
      return { id, members, score };
    });

  const humanHint = clusters.length === 0
    ? "no overlap clusters found"
    : clusters.map(c => `cluster (${c.members.length} pages, score ${c.score}): ${c.members.join(", ")}`).join("\n");
  return { exitCode: ExitCode.OK, result: ok({ clusters, humanHint }) };
}
