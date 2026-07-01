import { describe, it, expect } from "vitest";
import { buildGraphHtmlFromAdjacency } from "../../src/mcp/graph-html.js";

describe("buildGraphHtmlFromAdjacency", () => {
  it("emits HTML with nodes and edges", () => {
    const adj = {
      "concepts/a.md": ["concepts/b.md"],
      "concepts/b.md": ["entities/c.md"],
      "entities/c.md": [],
    };
    const r = buildGraphHtmlFromAdjacency(adj, 50);
    expect(r.node_count).toBe(3);
    expect(r.edge_count).toBeGreaterThanOrEqual(2);
    expect(r.html).toContain("<!DOCTYPE html>");
    expect(r.html).toContain("concepts/a");
    expect(r.html).toContain("<svg");
  });

  it("truncates when maxNodes exceeded", () => {
    const adj: Record<string, string[]> = {};
    for (let i = 0; i < 30; i++) adj[`concepts/n${i}.md`] = [];
    const r = buildGraphHtmlFromAdjacency(adj, 10);
    expect(r.truncated).toBe(true);
    expect(r.node_count).toBe(10);
  });
});