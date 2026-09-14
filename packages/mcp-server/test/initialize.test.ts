import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { mcpInitializeProtocolError } from "../src/mcp-initialize.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

describe("MCP initialize protocolVersion fail-closed", () => {
  it("rejects missing protocolVersion without returning server capabilities", () => {
    const missing = mcpInitializeProtocolError({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
    });
    expect(missing).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "protocolVersion is required" },
    });
    expect((missing as { result?: unknown; writer_id?: string }).result).toBeUndefined();
    expect((missing as { writer_id?: string }).writer_id).toBeUndefined();
  });

  it("rejects an unsupported protocolVersion without returning server capabilities", () => {
    const unsupported = mcpInitializeProtocolError({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "1999-01-01",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    });
    expect(unsupported?.error.code).toBe(-32602);
    expect(unsupported?.error.message).toBe("unsupported protocolVersion: 1999-01-01");
    expect((unsupported as { result?: { protocolVersion?: string } }).result).toBeUndefined();
    expect((unsupported as { writer_id?: string }).writer_id).toBeUndefined();
  });

  it("does not intercept supported initialize or non-initialize methods", () => {
    expect(mcpInitializeProtocolError({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    })).toBeNull();
    expect(mcpInitializeProtocolError({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "wiki_status", arguments: {} },
    })).toBeNull();
  });
});

describe("MCP initialize HTTP protocolVersion fail-closed", () => {
  async function startServer() {
    const vault = await makeTempVault();
    const token = "test-token";
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir: vault,
      tokenMap: new Map([[hash, "macos-dev"]]),
      gate,
      putObject: async () => undefined,
    });
    const { port } = server.address() as AddressInfo;
    return {
      token,
      port,
      close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
  }

  async function initialize(port: number, token: string, params: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params,
      }),
    });
  }

  it("HTTP initialize without protocolVersion is JSON-RPC invalid params", async () => {
    const ctx = await startServer();
    try {
      const res = await initialize(ctx.port, ctx.token, {
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { protocolVersion?: string; instructions?: string; writer_id?: string };
        error?: { code?: number; message?: string };
      };
      expect(body.result).toBeUndefined();
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.message).toBe("protocolVersion is required");
      expect(body.result?.writer_id).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("HTTP initialize with an unsupported protocolVersion is JSON-RPC invalid params", async () => {
    const ctx = await startServer();
    try {
      const res = await initialize(ctx.port, ctx.token, {
        protocolVersion: "1999-01-01",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { protocolVersion?: string; writer_id?: string };
        error?: { code?: number; message?: string };
      };
      expect(body.result).toBeUndefined();
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.message).toBe("unsupported protocolVersion: 1999-01-01");
      expect((body as { writer_id?: string }).writer_id).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
