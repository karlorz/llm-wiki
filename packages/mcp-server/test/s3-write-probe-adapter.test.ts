import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { probeS3Writable } from "../src/s3-write-probe.js";
import { createS3Adapter } from "../src/server.js";

it("probes through the production S3 adapter using one confined object key", async () => {
  const store = new Map<string, Buffer>();
  const calls: Array<{ method: string; path: string }> = [];
  const mockS3 = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    calls.push({ method: req.method!, path });
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      store.set(path, Buffer.concat(chunks));
      res.writeHead(200);
      res.end();
    } else if (req.method === "GET") {
      const body = store.get(path);
      res.writeHead(body ? 200 : 404);
      res.end(body);
    } else if (req.method === "DELETE") {
      store.delete(path);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise<void>((resolve) => mockS3.listen(0, "127.0.0.1", resolve));
  try {
    const port = (mockS3.address() as AddressInfo).port;
    const config = loadConfig({
      SKILLWIKI_MCP_VAULT: "/unused",
      SKILLWIKI_MCP_TOKEN_MAP: "/unused",
      SKILLWIKI_MCP_RCLONE_REMOTE: "mock",
      SKILLWIKI_MCP_RCLONE_BUCKET: "test-bucket/wiki",
      SKILLWIKI_MCP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
      SKILLWIKI_MCP_S3_BUCKET: "test-bucket",
      SKILLWIKI_MCP_S3_PREFIX: "wiki",
      SKILLWIKI_MCP_S3_ACCESS_KEY: "test-access",
      SKILLWIKI_MCP_S3_SECRET_KEY: "test-secret",
    });
    const adapter = createS3Adapter(config, undefined, 2_000);
    expect(await probeS3Writable({ hostId: "sg01", ...adapter })).toMatchObject({ s3Writable: true });
    expect(calls.map((call) => call.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(new Set(calls.map((call) => call.path)).size).toBe(1);
    expect(decodeURIComponent(calls[0].path)).toMatch(/^\/test-bucket\/wiki\/health\/probe\/sg01\/.*\.tmp$/);
    expect(store.size).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => mockS3.close((error) => error ? reject(error) : resolve()));
  }
});
