import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { buildWikilinkAdjacency } from "../utils/community.js";

export interface GraphBuildInput { vault: string; out: string }
export interface GraphBuildOutput { out_path: string; node_count: number; edge_count: number; humanHint: string }

export async function runGraphBuild(input: GraphBuildInput): Promise<{ exitCode: number; result: Result<GraphBuildOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const adjacency = await buildWikilinkAdjacency(scan.data.typedKnowledge);

  const adamicAdar = computeAdamicAdar(adjacency);
  const edge_count = Object.values(adjacency).reduce((acc, arr) => acc + arr.length, 0);

  try {
    await mkdir(dirname(input.out), { recursive: true });
    await writeFile(input.out, JSON.stringify({ adjacency, adamicAdar }, null, 2));
  } catch (e: unknown) {
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { message: String(e) }) };
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({ out_path: input.out, node_count: scan.data.typedKnowledge.length, edge_count, humanHint: `nodes: ${scan.data.typedKnowledge.length}, edges: ${edge_count}\nwritten: ${input.out}` })
  };
}

function computeAdamicAdar(adj: Record<string, string[]>): Record<string, Record<string, number>> {
  const undirected: Record<string, Set<string>> = {};
  for (const [a, neighbors] of Object.entries(adj)) {
    undirected[a] ??= new Set();
    for (const b of neighbors) {
      undirected[a].add(b);
      undirected[b] ??= new Set();
      undirected[b].add(a);
    }
  }
  const nodes = Object.keys(undirected);
  const out: Record<string, Record<string, number>> = {};
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const common = [...undirected[a]].filter(x => undirected[b].has(x));
      let score = 0;
      for (const c of common) {
        const deg = undirected[c].size;
        if (deg > 1) score += 1 / Math.log(deg);
      }
      if (score > 0) {
        out[a] ??= {}; out[a][b] = score;
        out[b] ??= {}; out[b][a] = score;
      }
    }
  }
  return out;
}
