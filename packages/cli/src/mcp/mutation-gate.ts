/** Mutating MCP tools require explicit opt-in (v2 backlog #1). */
export function mcpMutationsEnabled(): boolean {
  const v = process.env.SKILLWIKI_MCP_ALLOW_MUTATIONS;
  return v === "1" || v === "true" || v === "yes";
}

export const MCP_MUTATION_DISABLED_MESSAGE =
  "Mutating MCP tools are disabled. Set SKILLWIKI_MCP_ALLOW_MUTATIONS=true to enable skillwiki.observe (and future mutating tools).";