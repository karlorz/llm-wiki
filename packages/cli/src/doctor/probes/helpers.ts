import { CheckResult, CheckStatus } from "../types.js";

export const MCP_ONLY_LEAF_SKIP = "MCP-only leaf — check skipped";

export function check(status: CheckStatus, id: string, label: string, detail: string): CheckResult {
  return { id, label, status, detail };
}

export function mcpOnlyOr(
  mcpOnlyLeaf: boolean,
  id: string,
  label: string,
  fallback: CheckResult,
): CheckResult {
  if (mcpOnlyLeaf) return check("info", id, label, MCP_ONLY_LEAF_SKIP);
  return fallback;
}
