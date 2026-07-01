import { describe, it, expect, afterEach } from "vitest";
import { mcpMutationsEnabled } from "../../src/mcp/mutation-gate.js";

describe("mcpMutationsEnabled", () => {
  const prev = process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS;
    else process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS = prev;
  });

  it("defaults to false", () => {
    delete process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS;
    expect(mcpMutationsEnabled()).toBe(false);
  });

  it("enables on true/1/yes", () => {
    process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS = "true";
    expect(mcpMutationsEnabled()).toBe(true);
    process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS = "1";
    expect(mcpMutationsEnabled()).toBe(true);
  });
});