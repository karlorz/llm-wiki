import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveMcpVault } from "../../src/mcp/vault-resolve.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("resolveMcpVault", () => {
  it("accepts explicit vault with SCHEMA.md", async () => {
    const v = mkdtempSync(join(tmpdir(), "mcp-vault-"));
    dirs.push(v);
    writeFileSync(join(v, "SCHEMA.md"), "# schema\n");
    const r = await resolveMcpVault({ vault: v });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.vault).toBe(v);
  });

  it("rejects vault without SCHEMA.md", async () => {
    const v = mkdtempSync(join(tmpdir(), "mcp-bad-"));
    dirs.push(v);
    const r = await resolveMcpVault({ vault: v });
    expect(r.ok).toBe(false);
  });
});