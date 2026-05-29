import { describe, it, expect } from "vitest";
import {
  toUndirectedWeighted,
  louvain,
  communityCohesion,
  findSparseCommunities,
  type Adjacency,
} from "../../src/utils/community.js";

/** Build a star adjacency: one center linked to `leaves` leaves (bidirectional). */
function star(leaves: number): Adjacency {
  const adj: Adjacency = { center: [] };
  for (let i = 0; i < leaves; i++) {
    const l = `l${i}`;
    adj.center.push(l);
    adj[l] = ["center"];
  }
  return adj;
}

describe("toUndirectedWeighted", () => {
  it("symmetrizes directed edges with weight 1", () => {
    const g = toUndirectedWeighted({ a: ["b"], b: [] });
    expect(g.get("a")!.get("b")).toBe(1);
    expect(g.get("b")!.get("a")).toBe(1);
  });

  it("does not double-count reciprocal links", () => {
    const g = toUndirectedWeighted({ a: ["b"], b: ["a"] });
    expect(g.get("a")!.get("b")).toBe(1);
    expect(g.get("a")!.size).toBe(1);
  });

  it("keeps degree-0 nodes present", () => {
    const g = toUndirectedWeighted({ a: [], b: [] });
    expect(g.has("a")).toBe(true);
    expect(g.get("a")!.size).toBe(0);
  });

  it("ignores self-loops", () => {
    const g = toUndirectedWeighted({ a: ["a"] });
    expect(g.get("a")!.size).toBe(0);
  });
});

describe("louvain", () => {
  const distinct = (m: Map<string, number>) => new Set(m.values()).size;

  it("groups two disjoint triangles into two communities", () => {
    const adj: Adjacency = {
      a: ["b", "c"], b: ["a", "c"], c: ["a", "b"],
      d: ["e", "f"], e: ["d", "f"], f: ["d", "e"],
    };
    const comm = louvain(toUndirectedWeighted(adj));
    expect(distinct(comm)).toBe(2);
    expect(comm.get("a")).toBe(comm.get("b"));
    expect(comm.get("a")).toBe(comm.get("c"));
    expect(comm.get("d")).toBe(comm.get("e"));
    expect(comm.get("a")).not.toBe(comm.get("d"));
  });

  it("groups a single triangle into one community", () => {
    const comm = louvain(toUndirectedWeighted({ a: ["b", "c"], b: ["a", "c"], c: ["a", "b"] }));
    expect(distinct(comm)).toBe(1);
  });

  it("returns singleton communities for an edgeless graph", () => {
    const comm = louvain(toUndirectedWeighted({ a: [], b: [] }));
    expect(distinct(comm)).toBe(2);
  });

  it("is deterministic across runs", () => {
    const adj = star(6);
    const a = [...louvain(toUndirectedWeighted(adj)).entries()].sort();
    const b = [...louvain(toUndirectedWeighted(adj)).entries()].sort();
    expect(a).toEqual(b);
  });
});

describe("communityCohesion", () => {
  it("is 1.0 for a fully-connected triangle", () => {
    const g = toUndirectedWeighted({ a: ["b", "c"], b: ["a", "c"], c: ["a", "b"] });
    expect(communityCohesion(["a", "b", "c"], g)).toBe(1);
  });

  it("is 0.5 for a 4-node path (3 edges / 6 possible)", () => {
    const g = toUndirectedWeighted({ a: ["b"], b: ["c"], c: ["d"], d: [] });
    expect(communityCohesion(["a", "b", "c", "d"], g)).toBe(0.5);
  });

  it("returns 1 (never sparse) for a community smaller than 2", () => {
    const g = toUndirectedWeighted({ a: [] });
    expect(communityCohesion(["a"], g)).toBe(1);
  });
});

describe("findSparseCommunities", () => {
  it("flags a large low-density star community", () => {
    // 13 leaves + center = 14 nodes, 13 edges, density 13/91 = 0.143 < 0.15
    const out = findSparseCommunities(star(13));
    expect(out).toHaveLength(1);
    expect(out[0].size).toBe(14);
    expect(out[0].cohesion).toBeLessThan(0.15);
    expect(out[0].action).toBe("split into smaller topics");
    expect(out[0].members).toContain("center");
  });

  it("does not flag a dense clique", () => {
    const clique: Adjacency = {
      a: ["b", "c", "d"], b: ["a", "c", "d"], c: ["a", "b", "d"], d: ["a", "b", "c"],
    };
    expect(findSparseCommunities(clique)).toEqual([]);
  });

  it("does not flag communities below minSize", () => {
    // a 2-node link: a community of size 2 is below the default minSize 3
    expect(findSparseCommunities({ a: ["b"], b: ["a"] })).toEqual([]);
  });

  it("respects custom thresholds", () => {
    // With a high maxCohesion, even a triangle (cohesion 1.0) is not < 1.0
    expect(findSparseCommunities({ a: ["b", "c"], b: ["a", "c"], c: ["a", "b"] }, { maxCohesion: 1.0 })).toEqual([]);
  });
});
