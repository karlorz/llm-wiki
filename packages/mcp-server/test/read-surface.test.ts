import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

async function setupTestServer(opts?: { gateReady?: boolean }) {
  const vault = await makeTempVault();
  const token = "test-token";
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const gate = new ReconcileGate(async () => undefined);
  if (opts?.gateReady !== false) {
    await gate.runFirst();
  }
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
    vault,
    token,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function callTool(ctx: { port: number; token: string }, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = (await res.json()) as {
    result?: {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
  return { status: res.status, body: json };
}

describe("Slice 3 read surface tools", () => {
  const fiveTools = [
    "wiki_sources_pending",
    "wiki_compile_status",
    "wiki_reviews",
    "wiki_lint_summary",
    "wiki_stale",
  ];

  it("each of the five tools works after reconcile (ok: true or not TOOLS_NOT_READY)", async () => {
    const ctx = await setupTestServer({ gateReady: true });
    try {
      for (const tool of fiveTools) {
        const { status, body } = await callTool(ctx, tool, {});
        expect(status).toBe(200);
        const sc = body.result?.structuredContent;
        expect(sc).toBeDefined();
        expect(sc?.error).not.toBe("TOOLS_NOT_READY");
        expect(sc?.ok).toBe(true);
      }
    } finally {
      await ctx.close();
    }
  });

  it("each returns TOOLS_NOT_READY when gateReady is false", async () => {
    const ctx = await setupTestServer({ gateReady: false });
    try {
      for (const tool of fiveTools) {
        const { status, body } = await callTool(ctx, tool, {});
        expect(status).toBe(200);
        const sc = body.result?.structuredContent;
        expect(sc).toBeDefined();
        expect(sc?.ok).toBe(false);
        expect(sc?.error).toBe("TOOLS_NOT_READY");
      }
    } finally {
      await ctx.close();
    }
  });

  it("wiki_lint_summary and wiki_stale leave fixture vault files unchanged", async () => {
    const ctx = await setupTestServer({ gateReady: true });
    try {
      const conceptPath = join(ctx.vault, "concepts", "alpha.md");
      const hashBefore = createHash("sha256").update(await readFile(conceptPath)).digest("hex");

      const lintRes = await callTool(ctx, "wiki_lint_summary", {});
      expect(lintRes.body.result?.structuredContent?.ok).toBe(true);

      const staleRes = await callTool(ctx, "wiki_stale", {});
      expect(staleRes.body.result?.structuredContent?.ok).toBe(true);

      const hashAfter = createHash("sha256").update(await readFile(conceptPath)).digest("hex");
      expect(hashAfter).toBe(hashBefore);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_stale unknown or empty project -> USAGE, no writer_id", async () => {
    const ctx = await setupTestServer({ gateReady: true });
    try {
      const resUnknown = await callTool(ctx, "wiki_stale", { project: "nonexistent-project-xyz" });
      const scUnknown = resUnknown.body.result?.structuredContent;
      expect(scUnknown?.ok).toBe(false);
      expect(scUnknown?.error).toBe("USAGE");
      expect(scUnknown?.writer_id).toBeUndefined();

      const resEmpty = await callTool(ctx, "wiki_stale", { project: "   " });
      const scEmpty = resEmpty.body.result?.structuredContent;
      expect(scEmpty?.ok).toBe(false);
      expect(scEmpty?.error).toBe("USAGE");
      expect(scEmpty?.writer_id).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("wiki_sources_pending seeds pending raw article fixture and lists it", async () => {
    const ctx = await setupTestServer({ gateReady: true });
    try {
      await mkdir(join(ctx.vault, "raw", "articles"), { recursive: true });
      const rawArticle = join(ctx.vault, "raw", "articles", "2026-09-18-test-article.md");
      const articleContent = [
        "---",
        "title: Test Pending Article",
        "source_url: https://example.com/test-article",
        "ingested: 2026-09-18",
        "ingested_by: manual",
        "---",
        "Sample pending article content.",
      ].join("\n");
      await writeFile(rawArticle, articleContent, "utf8");

      const { status, body } = await callTool(ctx, "wiki_sources_pending", { match: "Test Pending Article" });
      expect(status).toBe(200);
      const sc = body.result?.structuredContent;
      expect(sc?.ok).toBe(true);
      const items = sc?.items as Array<{ raw_path: string; title: string }> | undefined;
      expect(items).toBeDefined();
      expect(items?.some((item) => item.raw_path === "raw/articles/2026-09-18-test-article.md")).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
