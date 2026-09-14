import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

export type JsonRpcErrorBody = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
};

function jsonRpcId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function invalidParams(id: unknown, message: string): JsonRpcErrorBody {
  return {
    jsonrpc: "2.0",
    id: jsonRpcId(id),
    error: { code: -32602, message },
  };
}

export function mcpInitializeProtocolError(parsed: unknown): JsonRpcErrorBody | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const req = parsed as { id?: unknown; method?: unknown; params?: unknown };
  if (req.method !== "initialize") return null;

  const params = req.params;
  const version =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  if (typeof version !== "string" || !version.trim()) {
    return invalidParams(req.id, "protocolVersion is required");
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return invalidParams(req.id, `unsupported protocolVersion: ${version}`);
  }
  return null;
}

export function mcpToolsListBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "tools/list" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "tools/list before initialize" },
      };
    }
  }
  return null;
}

export function mcpToolsCallBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "tools/call" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "tools/call before initialize" },
      };
    }
  }
  return null;
}

export function mcpResourcesListBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "resources/list" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "resources/list before initialize" },
      };
    }
  }
  return null;
}

export function mcpPromptsListBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "prompts/list" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "prompts/list before initialize" },
      };
    }
  }
  return null;
}
