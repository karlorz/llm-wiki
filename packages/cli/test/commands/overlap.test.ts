import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runOverlap } from "../../src/commands/overlap.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("overlap", () => {
  it("clusters pages that share raw sources", async () => {
    const r = await runOverlap({ vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // alpha + beta share x; beta + gamma share y → all three connected
      const big = r.result.data.clusters.find(c => c.members.length >= 2);
      expect(big).toBeDefined();
      expect(big!.score).toBeGreaterThan(0);
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runOverlap({ vault: "/nope" });
    expect(r.exitCode).toBe(9);
  });
});
