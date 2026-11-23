import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createS3Adapter } from "../src/server.js";
import { withWriteMutex } from "../src/txn.js";

function config(endpoint: string) {
  return loadConfig({
    SKILLWIKI_MCP_VAULT: "/unused",
    SKILLWIKI_MCP_TOKEN_MAP: "/unused",
    SKILLWIKI_MCP_RCLONE_REMOTE: "mock",
    SKILLWIKI_MCP_RCLONE_BUCKET: "test-bucket/wiki",
    SKILLWIKI_MCP_S3_ENDPOINT: endpoint,
    SKILLWIKI_MCP_S3_BUCKET: "test-bucket",
    SKILLWIKI_MCP_S3_PREFIX: "wiki",
    SKILLWIKI_MCP_S3_ACCESS_KEY: "test-access",
    SKILLWIKI_MCP_S3_SECRET_KEY: "test-secret",
  });
}

it("bounds a stalled default content request and releases the vault write queue", async () => {
  const server = createServer((req, res) => {
    if (req.url?.includes("stalled")) return;
    req.resume();
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const adapter = createS3Adapter(config(`http://127.0.0.1:${port}`));
    const stalled = withWriteMutex(() => adapter.putObject("stalled.md", Buffer.from("first")), "timeout-test");
    const failure = expect(stalled).rejects.toMatchObject({ code: "S3_PUT_FAILED" });
    const next = withWriteMutex(() => adapter.putObject("next.md", Buffer.from("second")), "timeout-test");
    await failure;
    await expect(next).resolves.toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 40_000);

it("bounds a GET whose response headers arrive but body never completes", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("partial");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const adapter = createS3Adapter(config(`http://127.0.0.1:${port}`), undefined, 200);
    await expect(adapter.getObject("stalled-body.md")).rejects.toMatchObject({ code: "S3_PUT_FAILED" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 3_000);
