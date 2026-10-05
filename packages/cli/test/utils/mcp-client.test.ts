import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withMcpClient, MCP_PROBE_TIMEOUT_MS } from "../../src/utils/mcp-client.js";

const plantedToken = "planted-sdk-probe-test-token";
const input = { url: "https://example.test/mcp", token: plantedToken, clientName: "probe-test", version: "0.10.108" };

interface RecordedRequest {
  method: string;
  rpcMethod?: string;
  headers: Headers;
  signal?: AbortSignal | null;
}

function fixtureFetch(options: {
  sse?: boolean;
  sessionId?: string;
  emptyInitialize?: boolean;
  httpError?: number;
  rpcError?: boolean;
} = {}): { fetchFn: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ method: init?.method ?? "GET", rpcMethod: body.method, headers: new Headers(init?.headers), signal: init?.signal });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (options.httpError) return new Response(`refused ${plantedToken}`, { status: options.httpError });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize" && options.emptyInitialize) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.10.108" } };
    } else if (body.method === "tools/list") {
      result = { tools: [{ name: "wiki_status", inputSchema: { type: "object" } }] };
    } else {
      result = { content: [], structuredContent: { ok: true } };
    }
    const response = options.rpcError
      ? { jsonrpc: "2.0", id: body.id, error: { code: -32603, message: `failed ${plantedToken}` } }
      : { jsonrpc: "2.0", id: body.id, result };
    const headers: Record<string, string> = { "Content-Type": options.sse ? "text/event-stream" : "application/json" };
    if (body.method === "initialize" && options.sessionId) headers["mcp-session-id"] = options.sessionId;
    const text = options.sse
      ? `: keepalive\nevent: message\n${JSON.stringify(response, null, 2).split("\n").map((line) => `data: ${line}`).join("\n")}\n\n`
      : JSON.stringify(response);
    return new Response(text, { status: 200, headers });
  };
  return { fetchFn, requests };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("withMcpClient", () => {
  it.each([false, true])("negotiates and parses JSON or multiline SSE (SSE=%s)", async (sse) => {
    const fixture = fixtureFetch({ sse, sessionId: "fixture-session" });
    const close = vi.spyOn(Client.prototype, "close");
    const result = await withMcpClient({ ...input, fetchFn: fixture.fetchFn }, async (client, signal) => {
      const tools = await client.listTools({}, { signal });
      const status = await client.callTool({ name: "wiki_status" }, undefined, { signal });
      return { version: client.getServerVersion()?.version, tools, status };
    });
    expect(result.version).toBe("0.10.108");
    expect(result.tools.tools[0].name).toBe("wiki_status");
    expect(result.status.structuredContent).toEqual({ ok: true });
    expect(fixture.requests.some((request) => request.rpcMethod === "notifications/initialized")).toBe(true);
    const listed = fixture.requests.find((request) => request.rpcMethod === "tools/list");
    expect(listed?.headers.get("mcp-session-id")).toBe("fixture-session");
    expect(listed?.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(listed?.headers.get("authorization")).toBe(`Bearer ${plantedToken}`);
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("works without a session ID", async () => {
    const fixture = fixtureFetch();
    await withMcpClient({ ...input, fetchFn: fixture.fetchFn }, (client, signal) => client.listTools({}, { signal }));
    expect(fixture.requests.find((request) => request.rpcMethod === "tools/list")?.headers.has("mcp-session-id")).toBe(false);
  });

  it.each([401, 403])("reports HTTP %s without disclosing the token", async (httpError) => {
    const fixture = fixtureFetch({ httpError });
    const result = withMcpClient({ ...input, fetchFn: fixture.fetchFn }, (client) => client.listTools());
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toThrow(plantedToken);
  });

  it("redacts JSON-RPC errors and closes the client", async () => {
    const fixture = fixtureFetch({ rpcError: true });
    const close = vi.spyOn(Client.prototype, "close");
    const result = withMcpClient({ ...input, fetchFn: fixture.fetchFn }, (client) => client.listTools());
    await expect(result).rejects.toThrow("[REDACTED]");
    await expect(result).rejects.not.toThrow(plantedToken);
    expect(close).toHaveBeenCalled();
  });

  it("does not accept an empty 202 initialize response", async () => {
    vi.useFakeTimers();
    const fixture = fixtureFetch({ emptyInitialize: true });
    const result = withMcpClient({ ...input, fetchFn: fixture.fetchFn }, (client) => client.listTools());
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(MCP_PROBE_TIMEOUT_MS);
    await rejected;
    expect(fixture.requests.some((request) => request.rpcMethod === "tools/list")).toBe(false);
    expect(fixture.requests.some((request) => request.rpcMethod === "notifications/initialized")).toBe(false);
  });

  it("bounds an unresponsive fetch and aborts outstanding requests", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetchFn: typeof fetch = async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    };
    const close = vi.spyOn(Client.prototype, "close");
    const result = withMcpClient({ ...input, fetchFn }, (client) => client.listTools());
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(MCP_PROBE_TIMEOUT_MS);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("bounds the entire probe rather than resetting the deadline after initialization", async () => {
    vi.useFakeTimers();
    const fixture = fixtureFetch();
    const result = withMcpClient({ ...input, fetchFn: fixture.fetchFn }, async () => new Promise<never>(() => {}));
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(MCP_PROBE_TIMEOUT_MS);
    await rejected;
  });
});
