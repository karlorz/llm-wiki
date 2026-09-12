import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPutObject, startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";
import { ReconcileGate } from "../src/reconcile.js";

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
});
