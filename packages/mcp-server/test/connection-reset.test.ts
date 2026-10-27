import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

describe("HTTP connection reset", () => {
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
      s3Writable: true,
      putObject: async () => undefined,
    });
    const { port } = server.address() as AddressInfo;
    return {
      port,
      close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
  }

  it("keeps serving /health after a client aborts a partial POST", async () => {
    const ctx = await startServer();
    try {
      await new Promise<void>((resolve) => {
        const sock = createConnection({ host: "127.0.0.1", port: ctx.port }, () => {
          sock.write("POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000\r\n\r\n{");
          sock.destroy();
        });
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
      });
      const res = await fetch(`http://127.0.0.1:${ctx.port}/health`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, reconcile_ready: true });
    } finally {
      await ctx.close();
    }
  });

  it("keeps serving /health after a malformed request triggers clientError", async () => {
    const ctx = await startServer();
    try {
      await new Promise<void>((resolve) => {
        const sock = createConnection({ host: "127.0.0.1", port: ctx.port }, () => {
          sock.write("GET / HTTP/1.1\r\nHost: \x00bad\r\n\r\n");
          sock.destroy();
        });
        sock.on("close", () => resolve());
        sock.on("error", () => resolve());
      });
      const res = await fetch(`http://127.0.0.1:${ctx.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });
});
