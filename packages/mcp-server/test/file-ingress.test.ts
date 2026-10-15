import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { adoptReadyHint, orderIngressPaths, ReadyHintSchema } from "../src/file-ingress.js";
import { startMcpHttpServer } from "../src/server.js";
import { ReconcileGate } from "../src/reconcile.js";
import { makeS3Store, makeTempVault } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("file-ingress ready hint", () => {
  it("orders assets before articles", () => {
    expect(orderIngressPaths(["raw/articles/a.md", "raw/assets/a/x.png", "raw/assets/a/note.md"])).toEqual([
      "raw/assets/a/x.png",
      "raw/assets/a/note.md",
      "raw/articles/a.md",
    ]);
  });

  it("adopts assets then article and emits exact paths", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ingress-vault-"));
    const article = Buffer.from("# clip\n");
    const store = makeS3Store();
    const assetPath = "raw/assets/cap/note.md";
    const articlePath = "raw/articles/cap.md";
    await store.putObject(assetPath, Buffer.from("index"));
    await store.putObject("raw/assets/cap/x.png", PNG);
    await store.putObject(articlePath, article);
    const emitted: string[][] = [];
    const result = await adoptReadyHint(
      {
        vault_id: "central",
        files: [
          { path: articlePath, sha256: createHash("sha256").update(article).digest("hex") },
          { path: "raw/assets/cap/x.png", sha256: createHash("sha256").update(PNG).digest("hex") },
          { path: assetPath, sha256: createHash("sha256").update(Buffer.from("index")).digest("hex") },
        ],
      },
      {
        vaultDir: vault,
        getObject: store.getObject,
        emitChanged: (paths) => emitted.push(paths),
      },
    );
    expect(result.ok).toBe(true);
    expect(emitted[0]?.[0]).toMatch(/^raw\/assets\//);
    expect(emitted[0]?.at(-1)).toMatch(/^raw\/articles\//);
  });

  it("rejects a tombstoned path before materialization", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ingress-tomb-"));
    const store = makeS3Store({ "raw/articles/gone.md": "nope" });
    const body = Buffer.from("nope");
    const result = await adoptReadyHint(
      {
        vault_id: "central",
        files: [{ path: "raw/articles/gone.md", sha256: createHash("sha256").update(body).digest("hex") }],
      },
      {
        vaultDir: vault,
        getObject: store.getObject,
        isTombstoned: () => true,
        emitChanged: () => {
          throw new Error("must not emit");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("tombstoned");
  });

  it("authenticates /file-ingress/ready separately from MCP and rejects MCP tokens", async () => {
    const vault = await makeTempVault();
    const mcpToken = "mcp-token";
    const ingressToken = "ingress-token";
    const mcpHash = createHash("sha256").update(mcpToken, "utf8").digest("hex");
    const ingressHash = createHash("sha256").update(ingressToken, "utf8").digest("hex");
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const store = makeS3Store();
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir: vault,
      tokenMap: new Map([[mcpHash, "macos-dev"]]),
      gate,
      putObject: store.putObject,
      getObject: store.getObject,
      fileIngressTokenSha256: ingressHash,
    });
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/file-ingress/ready`;
      const mcp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${mcpToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ vault_id: "central", files: [{ path: "raw/articles/a.md", sha256: "a".repeat(64) }] }),
      });
      expect(mcp.status).toBe(401);
      const parsed = ReadyHintSchema.safeParse({ vault_id: "central", files: [] });
      expect(parsed.success).toBe(false);
      const none = await fetch(url, { method: "POST", body: "{}" });
      expect(none.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
