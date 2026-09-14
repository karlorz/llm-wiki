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

export function mcpResourcesReadBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "resources/read" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "resources/read before initialize" },
      };
    }
  }
  return null;
}

export function mcpPromptsGetBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "prompts/get" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "prompts/get before initialize" },
      };
    }
  }
  return null;
}

export function mcpPingBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "ping" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "ping before initialize" },
      };
    }
  }
  return null;
}

export function mcpNotificationsInitializedError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  let seenInitialized = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") {
      seenInitialize = true;
      continue;
    }
    if (method === "notifications/initialized") {
      if (seenInitialized) {
        return {
          jsonrpc: "2.0",
          id: jsonRpcId((item as { id?: unknown }).id),
          error: { code: -32000, message: "duplicate notifications/initialized" },
        };
      }
      seenInitialized = true;
      continue;
    }
    if (seenInitialize && !seenInitialized) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "notifications/initialized missing" },
      };
    }
  }
  return null;
}

function cancelledRequestId(item: { params?: unknown }): string | number | null {
  const params = item.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return jsonRpcId((params as { requestId?: unknown }).requestId);
}

function mcpCancelledNotificationError(item: { id?: unknown; params?: unknown }): JsonRpcErrorBody | null {
  const requestId = cancelledRequestId(item);
  if (requestId === null) {
    return {
      jsonrpc: "2.0",
      id: jsonRpcId(item.id),
      error: { code: -32602, message: "requestId is required" },
    };
  }
  return null;
}

export function mcpNotificationsCancelledError(parsed: unknown): JsonRpcErrorBody | null {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const req = parsed as { method?: unknown; id?: unknown; params?: unknown };
    if (req.method !== "notifications/cancelled") return null;
    return mcpCancelledNotificationError(req);
  }
  if (!Array.isArray(parsed)) return null;

  const initializeIds = new Set<string | number>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const req = item as { method?: unknown; id?: unknown };
    if (req.method === "initialize") {
      const id = jsonRpcId(req.id);
      if (id !== null) initializeIds.add(id);
    }
  }
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const req = item as { method?: unknown; id?: unknown; params?: unknown };
    if (req.method !== "notifications/cancelled") continue;
    const missing = mcpCancelledNotificationError(req);
    if (missing) return missing;
    const requestId = cancelledRequestId(req);
    if (requestId !== null && initializeIds.has(requestId)) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId(req.id),
        error: { code: -32000, message: "notifications/cancelled of initialize" },
      };
    }
  }
  return null;
}

export function mcpLoggingSetLevelBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "logging/setLevel" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "logging/setLevel before initialize" },
      };
    }
  }
  return null;
}

export function mcpCompletionCompleteBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "completion/complete" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "completion/complete before initialize" },
      };
    }
  }
  return null;
}

export function mcpRootsListBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "roots/list" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "roots/list before initialize" },
      };
    }
  }
  return null;
}

export function mcpResourcesTemplatesListBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "resources/templates/list" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "resources/templates/list before initialize" },
      };
    }
  }
  return null;
}

export function mcpSamplingCreateMessageBeforeInitializeError(parsed: unknown): JsonRpcErrorBody | null {
  if (!Array.isArray(parsed)) return null;
  let seenInitialize = false;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const method = (item as { method?: unknown }).method;
    if (method === "initialize") seenInitialize = true;
    if (method === "sampling/createMessage" && !seenInitialize) {
      return {
        jsonrpc: "2.0",
        id: jsonRpcId((item as { id?: unknown }).id),
        error: { code: -32000, message: "sampling/createMessage before initialize" },
      };
    }
  }
  return null;
}
