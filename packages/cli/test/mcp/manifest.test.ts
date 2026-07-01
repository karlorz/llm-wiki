import { describe, it, expect } from "vitest";
import {
  MCP_READ_ONLY_TOOLS,
  MCP_RESOURCE_URIS,
  MCP_PROMPT_NAMES,
} from "../../src/mcp/manifest.js";

describe("MCP MVP manifest", () => {
  it("exposes seven read-only tools", () => {
    expect([...MCP_READ_ONLY_TOOLS]).toEqual([
      "skillwiki.query",
      "skillwiki.lint_summary",
      "skillwiki.doctor",
      "skillwiki.graph_build",
      "skillwiki.project_index",
      "skillwiki.stale",
      "skillwiki.config_get",
    ]);
  });

  it("exposes five resource URI patterns", () => {
    expect(MCP_RESOURCE_URIS).toHaveLength(5);
    expect(MCP_RESOURCE_URIS).toContain("skillwiki://vault/schema");
    expect(MCP_RESOURCE_URIS).toContain("skillwiki://graph/summary");
  });

  it("exposes four prompts", () => {
    expect(MCP_PROMPT_NAMES).toHaveLength(4);
    expect(MCP_PROMPT_NAMES).toContain("skillwiki-research-query");
  });
});