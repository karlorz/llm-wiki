import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runObserve } from "../commands/observe.js";
import { resolveMcpVault } from "./vault-resolve.js";
import { formatToolResult } from "./result-format.js";
import { runMcpToolHandler } from "./audit-log.js";
import { mcpMutationsEnabled, MCP_MUTATION_DISABLED_MESSAGE } from "./mutation-gate.js";
import { err, ExitCode } from "@skillwiki/shared";

const vaultFields = {
  vault: z.string().optional(),
  wiki: z.string().optional(),
};

/** Opt-in mutating tools (env SKILLWIKI_MCP_ALLOW_MUTATIONS=true). */
export function registerMcpMutatingTools(server: McpServer): void {
  server.registerTool(
    "skillwiki.observe",
    {
      description:
        "Create a new raw/transcripts capture file (mutating). Requires SKILLWIKI_MCP_ALLOW_MUTATIONS=true.",
      inputSchema: z.object({
        ...vaultFields,
        text: z.string().min(1).describe("Capture body text"),
        kind: z.enum(["note", "bug", "task", "idea", "session-log"]).optional(),
        project: z.string().optional().describe("Project slug for frontmatter"),
        confirm_mutation: z
          .literal(true)
          .describe("Must be true to acknowledge vault write"),
      }),
    },
    async (args) =>
      runMcpToolHandler("skillwiki.observe", { vault: args.vault, wiki: args.wiki }, async () => {
        if (!mcpMutationsEnabled()) {
          return formatToolResult({
            exitCode: ExitCode.USAGE,
            result: err("MCP_MUTATIONS_DISABLED", { message: MCP_MUTATION_DISABLED_MESSAGE }),
          });
        }
        const v = await resolveMcpVault({ vault: args.vault, wiki: args.wiki });
        if (!v.ok) return formatToolResult({ exitCode: 25, result: v });
        const r = await runObserve({
          vault: v.data.vault,
          text: args.text,
          kind: args.kind,
          project: args.project,
        });
        return formatToolResult(r);
      }),
  );
}