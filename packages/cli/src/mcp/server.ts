import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readCliPackageJson } from "../utils/package-info.js";
import { registerMcpTools } from "./tools.js";
import { registerMcpMutatingTools } from "./mutating-tools.js";
import { registerMcpResources } from "./resources.js";
import { registerMcpPrompts } from "./prompts.js";

export function createSkillwikiMcpServer(): McpServer {
  const pkg = readCliPackageJson();
  const server = new McpServer({
    name: "skillwiki-mcp",
    version: pkg.version,
  });
  registerMcpTools(server);
  registerMcpMutatingTools(server);
  registerMcpResources(server);
  registerMcpPrompts(server);
  return server;
}

export async function runSkillwikiMcpStdio(): Promise<void> {
  const server = createSkillwikiMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}