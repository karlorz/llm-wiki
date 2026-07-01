import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSkillwikiMcpServer } from "../../src/mcp/server.js";
import {
  MCP_READ_ONLY_TOOLS,
  MCP_PROMPT_NAMES,
  MCP_RESOURCE_URIS,
} from "../../src/mcp/manifest.js";

describe("skillwiki MCP integration (in-memory)", () => {
  let client: Client | undefined;
  let serverTransport: InMemoryTransport | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    serverTransport = undefined;
  });

  async function connectPair(): Promise<Client> {
    const [clientTransport, serverSide] = InMemoryTransport.createLinkedPair();
    serverTransport = serverSide;
    const server = createSkillwikiMcpServer();
    await server.connect(serverSide);

    const c = new Client({ name: "skillwiki-mcp-test", version: "0.0.0" });
    await c.connect(clientTransport);
    client = c;
    return c;
  }

  it("lists seven read-only tools matching manifest", async () => {
    const c = await connectPair();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_READ_ONLY_TOOLS].sort());
  });

  it("lists four prompts matching manifest", async () => {
    const c = await connectPair();
    const { prompts } = await c.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([...MCP_PROMPT_NAMES].sort());
  });

  it("lists resources including vault schema URI", async () => {
    const c = await connectPair();
    const { resources } = await c.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("skillwiki://vault/schema");
    expect(uris).toContain("skillwiki://vault/index");
    expect(uris).toContain("skillwiki://graph/summary");
    // Templates may also appear via listResourceTemplates
    const templates = await c.listResourceTemplates();
    const templateUris = templates.resourceTemplates.map((t) => t.uriTemplate);
    const allPatterns = [...uris, ...templateUris];
    expect(allPatterns.some((u) => u.includes("log-tail"))).toBe(true);
    expect(allPatterns.some((u) => u.includes("project"))).toBe(true);
    expect(MCP_RESOURCE_URIS.length).toBe(5);
  });
});