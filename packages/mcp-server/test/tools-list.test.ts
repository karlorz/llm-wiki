import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { mcpToolsListBeforeInitializeError } from "../src/mcp-initialize.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

const supportedInitialize = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "vitest", version: "0" },
};

describe("MCP tools/list before initialize fail-closed", () => {
  it("rejects a JSON-RPC batch that lists tools before initialize", () => {
    const err = mcpToolsListBeforeInitializeError([
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "initialize", params: supportedInitialize },
    ]);
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "tools/list before initialize" },
    });
    expect((err as { result?: { tools?: unknown[] } }).result).toBeUndefined();
    expect((err as { writer_id?: string }).writer_id).toBeUndefined();
  });

  it("does not intercept a standalone tools/list or a batch that initializes first", () => {
    expect(mcpToolsListBeforeInitializeError({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    })).toBeNull();
    expect(mcpToolsListBeforeInitializeError([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: supportedInitialize },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ])).toBeNull();
  });
});

describe("MCP tools/list HTTP before initialize fail-closed", () => {
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

  it("HTTP JSON-RPC batch tools/list before initialize returns no tools and no writer_id", async () => {
    const ctx = await startServer();
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
          { jsonrpc: "2.0", id: 12, method: "initialize", params: supportedInitialize },
        ]),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { tools?: unknown[]; writer_id?: string };
        error?: { code?: number; message?: string };
        writer_id?: string;
      };
      expect(body.result).toBeUndefined();
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toBe("tools/list before initialize");
      expect(body.writer_id).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
