import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { mcpResourcesUnsubscribeAfterShutdownError } from "../src/mcp-initialize.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

const supportedInitialize = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "vitest", version: "0" },
};

const unsubscribeParams = { uri: "wiki://page/index.md" };

describe("MCP resources/unsubscribe after shutdown fail-closed", () => {
  it("rejects a JSON-RPC batch that unsubscribes after shutdown", () => {
    const err = mcpResourcesUnsubscribeAfterShutdownError([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: supportedInitialize },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "shutdown", params: null },
      { jsonrpc: "2.0", id: 3, method: "resources/unsubscribe", params: unsubscribeParams },
    ]);
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32000, message: "resources/unsubscribe after shutdown" },
    });
    expect((err as { result?: unknown }).result).toBeUndefined();
    expect((err as { writer_id?: string }).writer_id).toBeUndefined();
  });

  it("does not intercept a standalone resources/unsubscribe or resources/unsubscribe before shutdown", () => {
    expect(mcpResourcesUnsubscribeAfterShutdownError({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/unsubscribe",
      params: unsubscribeParams,
    })).toBeNull();
    expect(mcpResourcesUnsubscribeAfterShutdownError([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: supportedInitialize },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "resources/unsubscribe", params: unsubscribeParams },
      { jsonrpc: "2.0", id: 3, method: "shutdown", params: null },
    ])).toBeNull();
  });
});

describe("MCP resources/unsubscribe after shutdown HTTP fail-closed", () => {
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

  it("HTTP JSON-RPC batch resources/unsubscribe after shutdown returns no result and no writer_id", async () => {
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
          { jsonrpc: "2.0", id: 341, method: "initialize", params: supportedInitialize },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 342, method: "shutdown", params: null },
          { jsonrpc: "2.0", id: 343, method: "resources/unsubscribe", params: unsubscribeParams },
        ]),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string };
        writer_id?: string;
      };
      expect(body.result).toBeUndefined();
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toBe("resources/unsubscribe after shutdown");
      expect(body.writer_id).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
