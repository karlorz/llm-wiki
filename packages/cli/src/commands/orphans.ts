import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { resolveRuntimePath } from "../utils/wiki-path.js";

export interface OrphansInput { vault: string | undefined; envValue?: string; home?: string }
export interface OrphansOutput {
  orphans: string[];
  bridges: Array<{ path: string; connects: string[] }>;
}

export async function runOrphans(input: OrphansInput): Promise<{ exitCode: number; result: Result<OrphansOutput> }> {
  let vault: string;
  if (input.vault) {
    vault = input.vault;
  } else {
    const r = await resolveRuntimePath({ flag: undefined, envValue: input.envValue, home: input.home ?? "" });
    if (!r.ok) return { exitCode: ExitCode.NO_VAULT_CONFIGURED, result: r };
    vault = r.data.path;
  }

  const scan = await scanVault(vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const slugToPath: Record<string, string> = {};
  for (const p of scan.data.typedKnowledge) {
    slugToPath[p.relPath.replace(/\.md$/, "").split("/").pop()!] = p.relPath;
  }
  const adj: Record<string, Set<string>> = {};
  for (const p of scan.data.typedKnowledge) adj[p.relPath] = new Set();

  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    for (const slug of extractBodyWikilinks(body)) {
      const tgt = slugToPath[slug.split("/").pop()!];
      if (tgt) {
        adj[p.relPath].add(tgt);
        adj[tgt].add(p.relPath);
      }
    }
  }

  const orphans = Object.keys(adj).filter(k => adj[k].size === 0);

  // Connected components via DFS.
  const componentOf: Record<string, number> = {};
  let cid = 0;
  for (const node of Object.keys(adj)) {
    if (componentOf[node] !== undefined) continue;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      if (componentOf[n] !== undefined) continue;
      componentOf[n] = cid;
      for (const nb of adj[n]) stack.push(nb);
    }
    cid++;
  }

  const bridges: OrphansOutput["bridges"] = [];
  for (const node of Object.keys(adj)) {
    const neighborComps = new Set([...adj[node]].map(n => componentOf[n]));
    if (adj[node].size >= 2 && neighborComps.size === 1) {
      const without = simulateRemoval(adj, node);
      if (without > Object.values(componentOf).filter((v, i, a) => a.indexOf(v) === i).length) {
        bridges.push({ path: node, connects: [...adj[node]] });
      }
    }
  }
  return { exitCode: ExitCode.OK, result: ok({ orphans, bridges }) };
}

function simulateRemoval(adj: Record<string, Set<string>>, removed: string): number {
  const seen = new Set<string>();
  let comps = 0;
  for (const start of Object.keys(adj)) {
    if (start === removed || seen.has(start)) continue;
    comps++;
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n) || n === removed) continue;
      seen.add(n);
      for (const nb of adj[n]) if (nb !== removed) stack.push(nb);
    }
  }
  return comps;
}
