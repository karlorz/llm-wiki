import { runSkillwikiMcpStdio } from "./mcp/server.js";

runSkillwikiMcpStdio().catch((error: unknown) => {
  console.error("skillwiki-mcp fatal:", error);
  process.exit(1);
});