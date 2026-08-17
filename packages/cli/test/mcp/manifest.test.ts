import { describe, it, expect } from "vitest";
import {
  MCP_READ_ONLY_TOOLS,
  MCP_RESOURCE_URIS,
  MCP_PROMPT_NAMES,
} from "../../src/mcp/manifest.js";

describe("MCP MVP manifest", () => {
  it("exposes ten read-only tools", () => {
    expect([...MCP_READ_ONLY_TOOLS]).toEqual([
      "skillwiki.query",
      "skillwiki.lint_summary",
      "skillwiki.doctor",
      "skillwiki.graph_build",
      "skillwiki.project_index",
      "skillwiki.stale",
      "skillwiki.config_get",
      "skillwiki.sources_pending",
      "skillwiki.compile_status",
      "skillwiki.reviews",
    ]);
  });

  it("exposes eight resource URI patterns (incl. v2 pagination)", () => {
    expect(MCP_RESOURCE_URIS).toHaveLength(11);
    expect(MCP_RESOURCE_URIS).toContain("skillwiki://vault/schema");
    expect(MCP_RESOURCE_URIS).toContain("skillwiki://graph/summary");
  });

  it("exposes five prompts", () => {
    expect(MCP_PROMPT_NAMES).toHaveLength(5);
    expect(MCP_PROMPT_NAMES).toContain("skillwiki-research-query");
    expect(MCP_PROMPT_NAMES).toContain("skillwiki-pending-review");
  });
});