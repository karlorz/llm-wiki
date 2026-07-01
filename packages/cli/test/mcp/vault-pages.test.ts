import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { listVaultPages } from "../../src/mcp/vault-pages.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("listVaultPages", () => {
  it("returns paginated typed paths", async () => {
    const r = await listVaultPages({ vault: VAULT, layer: "typed", offset: 0, limit: 5 });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.paths.length).toBeLessThanOrEqual(5);
      expect(r.result.data.total).toBeGreaterThanOrEqual(r.result.data.paths.length);
    }
  });
});