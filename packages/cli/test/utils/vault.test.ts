import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { scanVault } from "../../src/utils/vault.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("scanVault", () => {
  it("rejects when SCHEMA.md missing", async () => {
    const r = await scanVault("/no/such/path");
    expect(r.ok).toBe(false);
  });

  it("returns markdown files grouped by layer", async () => {
    const r = await scanVault(VAULT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.typedKnowledge.map(p => p.relPath).sort()).toEqual([
        "concepts/alpha.md", "concepts/beta.md", "concepts/gamma.md"
      ]);
      expect(r.data.raw.map(p => p.relPath).sort()).toEqual([
        "raw/articles/x.md", "raw/articles/y.md"
      ]);
    }
  });
});
