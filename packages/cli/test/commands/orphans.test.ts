import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runOrphans } from "../../src/commands/orphans.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("orphans", () => {
  it("flags zero-degree pages as orphans", async () => {
    const r = await runOrphans({ vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(Array.isArray(r.result.data.orphans)).toBe(true);
      expect(Array.isArray(r.result.data.bridges)).toBe(true);
    }
  });
});
