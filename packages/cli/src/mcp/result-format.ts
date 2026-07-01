import type { Result } from "@skillwiki/shared";

export interface McpToolPayload<T = unknown> {
  exitCode: number;
  result: Result<T>;
}

/** Serialize CLI Result envelope for MCP tool responses (JSON text + metadata). */
export function formatToolResult<T>(payload: McpToolPayload<T>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: { exitCode: number };
} {
  const text = JSON.stringify(payload.result, null, 2);
  const isError = !payload.result.ok;
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
    _meta: { exitCode: payload.exitCode },
  };
}