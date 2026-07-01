/** Read-only MCP tool names (MVP). */
export const MCP_READ_ONLY_TOOLS = [
  "skillwiki.query",
  "skillwiki.lint_summary",
  "skillwiki.doctor",
  "skillwiki.graph_build",
  "skillwiki.project_index",
  "skillwiki.stale",
  "skillwiki.config_get",
] as const;

export const MCP_RESOURCE_URIS = [
  "skillwiki://vault/schema",
  "skillwiki://vault/index",
  "skillwiki://vault/log-tail",
  "skillwiki://vault/pages",
  "skillwiki://project/{slug}/index",
  "skillwiki://graph/summary",
  "skillwiki://lint/{bucket}",
  "skillwiki://query/preview",
] as const;

export const MCP_PROMPT_NAMES = [
  "skillwiki-research-query",
  "skillwiki-project-work-item",
  "skillwiki-vault-health-review",
  "skillwiki-citation-audit",
] as const;