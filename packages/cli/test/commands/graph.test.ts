import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runGraphBuild } from "../../src/commands/graph.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("graph build", () => {
  it("computes adjacency for the sample vault", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "sw-graph-")), "graph.json");
    const r = await runGraphBuild({ vault: VAULT, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(3);
      expect(r.result.data.edge_count).toBeGreaterThan(0);
      expect(r.result.data.out_path).toBe(out);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.adjacency["concepts/alpha.md"]).toContain("concepts/beta.md");
      expect(data.adamicAdar).toBeDefined();
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runGraphBuild({ vault: "/no/path", out: "/tmp/g.json" });
    expect(r.exitCode).toBe(9);
  });
});
