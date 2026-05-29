import { readPage, type VaultPage } from "./vault.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

/** Directed wikilink adjacency: page relPath -> linked page relPaths. */
export type Adjacency = Record<string, string[]>;

/** Undirected weighted graph: node -> (neighbor -> weight). */
export type WeightedGraph = Map<string, Map<string, number>>;

export interface SparseCommunity {
  members: string[];
  size: number;
  cohesion: number;
  action: string;
}

/**
 * Build the directed wikilink adjacency over a vault's typed-knowledge pages.
 * Extracted from graph.ts so both the graph builder and the sparse-community
 * lint check share one pass (no duplication). Takes the already-scanned page
 * list so callers keep their own vault-validity guard.
 */
export async function buildWikilinkAdjacency(typedKnowledge: VaultPage[]): Promise<Adjacency> {
  const adjacency: Adjacency = {};
  const slugToPath: Record<string, string> = {};
  for (const p of typedKnowledge) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    slugToPath[slug] = p.relPath;
  }
  for (const p of typedKnowledge) {
    const text = await readPage(p);
    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;
    const links = extractBodyWikilinks(body);
    adjacency[p.relPath] = links
      .map(slug => slugToPath[slug.split("/").pop()!])
      .filter((x): x is string => Boolean(x));
  }
  return adjacency;
}

/**
 * Symmetrize a directed adjacency into an undirected weighted graph.
 * Edge weight is a flat 1.0 fallback (multi-signal weights are a later
 * refinement). Reciprocal links do not double-count (Map.set is idempotent).
 * Every node in `adj` is present, including degree-0 nodes.
 */
export function toUndirectedWeighted(adj: Adjacency): WeightedGraph {
  const g: WeightedGraph = new Map();
  const ensure = (n: string): Map<string, number> => {
    let m = g.get(n);
    if (!m) { m = new Map(); g.set(n, m); }
    return m;
  };
  for (const node of Object.keys(adj)) ensure(node);
  for (const [a, nbrs] of Object.entries(adj)) {
    for (const b of nbrs) {
      if (a === b) continue;
      ensure(a).set(b, 1);
      ensure(b).set(a, 1);
    }
  }
  return g;
}

/**
 * Single-level Louvain modularity optimization (local-moving phase).
 * Zero-dependency, in-tree. Returns node -> communityId.
 *
 * Node iteration follows a stable sort of node ids so results are
 * reproducible. A single level is sufficient for this vault's size and the
 * info-severity use case; multi-level aggregation is intentionally omitted.
 */
export function louvain(g: WeightedGraph): Map<string, number> {
  const nodes = [...g.keys()].sort();
  const comm = new Map<string, number>();
  nodes.forEach((n, i) => comm.set(n, i));

  const k = new Map<string, number>(); // weighted degree
  let m2 = 0;                           // 2m = sum of degrees
  for (const n of nodes) {
    let deg = 0;
    for (const w of g.get(n)!.values()) deg += w;
    k.set(n, deg);
    m2 += deg;
  }
  if (m2 === 0) return comm; // no edges → singleton communities

  const sumTot = new Map<number, number>();
  for (const n of nodes) {
    const c = comm.get(n)!;
    sumTot.set(c, (sumTot.get(c) ?? 0) + k.get(n)!);
  }

  let improved = true;
  while (improved) {
    improved = false;
    for (const n of nodes) {
      const cur = comm.get(n)!;
      const kn = k.get(n)!;

      // Detach n from its community.
      sumTot.set(cur, sumTot.get(cur)! - kn);

      // Sum of edge weights from n into each candidate community.
      const wToComm = new Map<number, number>();
      for (const [nb, w] of g.get(n)!) {
        if (nb === n) continue;
        const c = comm.get(nb)!;
        wToComm.set(c, (wToComm.get(c) ?? 0) + w);
      }

      // ΔQ-proportional gain of placing n into community c.
      const gainFor = (c: number): number =>
        (wToComm.get(c) ?? 0) - (sumTot.get(c) ?? 0) * kn / m2;

      const curGain = gainFor(cur);
      let bestComm = cur;
      let bestDelta = 0;
      for (const c of wToComm.keys()) {
        const delta = gainFor(c) - curGain;
        if (delta > bestDelta) { bestDelta = delta; bestComm = c; }
      }

      comm.set(n, bestComm);
      sumTot.set(bestComm, (sumTot.get(bestComm) ?? 0) + kn);
      if (bestComm !== cur) improved = true;
    }
  }
  return comm;
}

/**
 * Cohesion of a community: internal edge weight sum / C(n, 2).
 * With unit weights this is the internal edge density. n < 2 → 1 (never sparse).
 */
export function communityCohesion(members: string[], g: WeightedGraph): number {
  const n = members.length;
  if (n < 2) return 1;
  const set = new Set(members);
  let internal = 0;
  for (const a of members) {
    for (const [b, w] of g.get(a) ?? new Map<string, number>()) {
      if (a < b && set.has(b)) internal += w; // count each undirected edge once
    }
  }
  return internal / (n * (n - 1) / 2);
}

/**
 * Detect sparse communities: run Louvain, compute per-community cohesion, and
 * return communities with `size >= minSize AND cohesion < maxCohesion`,
 * sorted by cohesion ascending (loosest first).
 */
export function findSparseCommunities(
  adj: Adjacency,
  opts: { minSize?: number; maxCohesion?: number } = {},
): SparseCommunity[] {
  const minSize = opts.minSize ?? 3;
  const maxCohesion = opts.maxCohesion ?? 0.15;

  const g = toUndirectedWeighted(adj);
  const comm = louvain(g);

  const groups = new Map<number, string[]>();
  for (const [node, c] of comm) {
    const arr = groups.get(c);
    if (arr) arr.push(node); else groups.set(c, [node]);
  }

  const out: SparseCommunity[] = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    const cohesion = communityCohesion(members, g);
    if (cohesion < maxCohesion) {
      out.push({
        members: [...members].sort(),
        size: members.length,
        cohesion: Math.round(cohesion * 1000) / 1000,
        action: members.length <= 5 ? "merge into adjacent community" : "split into smaller topics",
      });
    }
  }
  out.sort((a, b) => a.cohesion - b.cohesion);
  return out;
}
