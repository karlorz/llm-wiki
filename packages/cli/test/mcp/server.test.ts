import { describe, it, expect } from "vitest";
import { createSkillwikiMcpServer } from "../../src/mcp/server.js";
import { MCP_READ_ONLY_TOOLS, MCP_PROMPT_NAMES, MCP_RESOURCE_URIS } from "../../src/mcp/manifest.js";

describe("skillwiki MCP server", () => {
  it("creates server with expected MVP surface manifest", () => {
    const server = createSkillwikiMcpServer();
    expect(server).toBeDefined();
    expect(MCP_READ_ONLY_TOOLS).toHaveLength(7);
    expect(MCP_RESOURCE_URIS).toHaveLength(8);
    expect(MCP_PROMPT_NAMES).toHaveLength(4);
  });
});