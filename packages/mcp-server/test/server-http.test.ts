import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPutObject, startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";
import { ReconcileGate } from "../src/reconcile.js";

const pkgVersion = (
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

describe("HTTP surface", () => {
  it("createPutObject fails closed without S3 credentials", () => {
    expect(() =>
      createPutObject(
        loadConfig({
          SKILLWIKI_MCP_VAULT: "/vault",
          SKILLWIKI_MCP_TOKEN_MAP: "/tokens.yaml",
          SKILLWIKI_MCP_RCLONE_REMOTE: "seaweed-wiki",
          SKILLWIKI_MCP_RCLONE_BUCKET: "cloud/wiki",
        }),
      ),
    ).toThrow(/fail closed/);
  });

  it("GET /events and /mcp/events without or unknown bearer are 401", async () => {
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
    try {
      const { port } = server.address() as AddressInfo;
      for (const path of ["/events", "/mcp/events"]) {
        const none = await fetch(`http://127.0.0.1:${port}${path}`);
        expect(none.status, path).toBe(401);
        expect(none.headers.get("www-authenticate")).toBe("Bearer");
        const unknown = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: { Authorization: "Bearer unknown-not-in-token-map" },
        });
        expect(unknown.status, path).toBe(401);
      }
      const ok = await fetch(`http://127.0.0.1:${port}/mcp/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/text\/event-stream/);
      await ok.body?.cancel();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("returns 401 WWW-Authenticate Bearer without a token", async () => {
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
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("binds loopback only when configured", async () => {
    const vault = await makeTempVault();
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir: vault,
      tokenMap: new Map(),
      gate,
      putObject: async () => undefined,
    });
    try {
      const addr = server.address() as AddressInfo;
      expect(addr.address).toMatch(/127\.0\.0\.1|::1/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("initialize serverInfo.version matches package.json", async () => {
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
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "vitest", version: "0" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result?: { serverInfo?: { name?: string; version?: string } } };
      expect(body.result?.serverInfo?.name).toBe("skillwiki-mcp");
      expect(body.result?.serverInfo?.version).toBe(pkgVersion);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
