import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseVaultAllowlist, vaultAllowedByList } from "../../src/mcp/allowlist.js";

describe("MCP vault allowlist", () => {
  it("parseVaultAllowlist returns null when unset", () => {
    expect(parseVaultAllowlist(undefined)).toBeNull();
    expect(parseVaultAllowlist("  ")).toBeNull();
  });

  it("vaultAllowedByList permits paths under allowed root", () => {
    const wiki = join(tmpdir(), "skillwiki-mcp-allow-wiki");
    const other = join(tmpdir(), "skillwiki-mcp-allow-other");
    const roots = parseVaultAllowlist(`${wiki},${other}`);
    expect(vaultAllowedByList(wiki, roots)).toBe(true);
    expect(vaultAllowedByList(join(wiki, "projects", "x"), roots)).toBe(true);
    expect(vaultAllowedByList(join(tmpdir(), "skillwiki-mcp-denied"), roots)).toBe(false);
  });

  it("null allowlist allows any path", () => {
    expect(vaultAllowedByList("/any/path", null)).toBe(true);
  });
});