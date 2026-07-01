import { describe, it, expect } from "vitest";
import { parseVaultAllowlist, vaultAllowedByList } from "../../src/mcp/allowlist.js";

describe("MCP vault allowlist", () => {
  it("parseVaultAllowlist returns null when unset", () => {
    expect(parseVaultAllowlist(undefined)).toBeNull();
    expect(parseVaultAllowlist("  ")).toBeNull();
  });

  it("vaultAllowedByList permits paths under allowed root", () => {
    const roots = parseVaultAllowlist("/Users/alice/wiki,/tmp/other");
    expect(vaultAllowedByList("/Users/alice/wiki", roots)).toBe(true);
    expect(vaultAllowedByList("/Users/alice/wiki/projects/x", roots)).toBe(true);
    expect(vaultAllowedByList("/Users/bob/wiki", roots)).toBe(false);
  });

  it("null allowlist allows any path", () => {
    expect(vaultAllowedByList("/any/path", null)).toBe(true);
  });
});