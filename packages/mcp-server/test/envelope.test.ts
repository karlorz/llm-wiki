import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { MAX_READ_PAGE_BYTES } from "../src/tools/reads.js";
import { makeTempVault } from "./helpers.js";

async function setupTestServer() {
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
    vault,
    token,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("C4 typed result envelope and request body cap", () => {
  it("tools/call returns structuredContent and mirror text in content[0]", async () => {
    const ctx = await setupTestServer();
    try {
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
          params: {
            name: "wiki_status",
            arguments: {},
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text: string }>;
        };
      };
      expect(body.result?.structuredContent).toBeDefined();
      expect(body.result?.structuredContent?.ok).toBe(true);
      expect(body.result?.structuredContent?.reconcile_ready).toBe(true);
      expect(body.result?.content?.[0]?.type).toBe("text");
      const parsedText = JSON.parse(body.result?.content?.[0]?.text ?? "{}");
      expect(parsedText).toEqual(body.result?.structuredContent);
    } finally {
      await ctx.close();
    }
  });

  it("tools/list includes all 9 tools with outputSchema and annotations", async () => {
    const ctx = await setupTestServer();
    try {
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
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            outputSchema?: Record<string, unknown>;
            annotations?: Record<string, unknown>;
          }>;
        };
      };
      const tools = body.result?.tools ?? [];
      const toolMap = new Map(tools.map((t) => [t.name, t]));

      const expectedReads = ["wiki_query", "wiki_read_page", "wiki_memory_recall", "wiki_status", "wiki_context"];
      const nonIdempotentWrites = ["wiki_capture", "wiki_log_append"];
      const idempotentWrites = ["wiki_workitem_write", "wiki_page_publish"];

      expect(toolMap.size).toBe(9);

      for (const name of expectedReads) {
        const tool = toolMap.get(name);
        expect(tool, `tool ${name} exists`).toBeDefined();
        expect(tool?.outputSchema, `tool ${name} has outputSchema`).toBeDefined();
        expect(tool?.annotations).toEqual({ readOnlyHint: true });
      }

      for (const name of nonIdempotentWrites) {
        const tool = toolMap.get(name);
        expect(tool, `tool ${name} exists`).toBeDefined();
        expect(tool?.outputSchema, `tool ${name} has outputSchema`).toBeDefined();
        expect(tool?.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        });
      }

      for (const name of idempotentWrites) {
        const tool = toolMap.get(name);
        expect(tool, `tool ${name} exists`).toBeDefined();
        expect(tool?.outputSchema, `tool ${name} has outputSchema`).toBeDefined();
        expect(tool?.annotations).toEqual({
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        });
      }
    } finally {
      await ctx.close();
    }
  });

  it("POST /mcp with body > 1 MiB returns JSON error without crash", async () => {
    const ctx = await setupTestServer();
    try {
      // Create body slightly larger than 1 MiB (1048576 bytes)
      const oversized = "x".repeat(1024 * 1024 + 10);
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ padding: oversized }),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeDefined();

      // Ensure server is still alive and responsive after oversized request
      const healthRes = await fetch(`http://127.0.0.1:${ctx.port}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it("POST /mcp with a valid bearer and malformed JSON is 400 and writes nothing", async () => {
    const ctx = await setupTestServer();
    const beforeLog = await readFile(join(ctx.vault, "log.md"), "utf8");
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: "{not-json",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; writer_id?: string };
      expect(body.error).toBe("invalid_json");
      expect(body.writer_id).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("chatgpt-web");
      expect(await readdir(join(ctx.vault, "raw", "transcripts"))).toEqual([]);
      expect(await readFile(join(ctx.vault, "log.md"), "utf8")).toBe(beforeLog);

      const healthRes = await fetch(`http://127.0.0.1:${ctx.port}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_read_page rejects >256 KiB page with PAGE_TOO_LARGE and compact response envelope", async () => {
    const ctx = await setupTestServer();
    try {
      const largeRelPath = "concepts/large-page.md";
      const largeContent = "---\ntitle: Large Page\n---\n" + "x".repeat(MAX_READ_PAGE_BYTES + 1);
      await writeFile(join(ctx.vault, largeRelPath), largeContent, "utf8");

      const largeRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "wiki_read_page",
            arguments: { path: largeRelPath },
          },
        }),
      });
      expect(largeRes.status).toBe(200);

      const rawResponseText = await largeRes.text();
      expect(Buffer.byteLength(rawResponseText, "utf8")).toBeLessThan(4096);

      const largeBody = JSON.parse(rawResponseText) as {
        result?: {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
          content?: Array<{ type: string; text: string }>;
        };
      };

      const structured = largeBody.result?.structuredContent as Record<string, unknown> | undefined;
      expect(largeBody.result?.isError).toBe(true);
      expect(structured?.ok).toBe(false);
      expect(structured?.error).toBe("PAGE_TOO_LARGE");
      expect(structured?.path).toBe(largeRelPath);
      expect(structured?.message).toBe(
        `page exceeds ${MAX_READ_PAGE_BYTES}-byte wiki_read_page limit; request a smaller page`,
      );
      expect(structured?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(structured?.byte_length).toBe(Buffer.byteLength(largeContent, "utf8"));
      expect(typeof structured?.s3_verified).toBe("boolean");
      expect(largeBody.result?.content?.[0]?.type).toBe("text");
      expect(JSON.parse(largeBody.result?.content?.[0]?.text ?? "{}")).toEqual(structured);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP missing path or content fail-closed with no file written", async () => {
    const ctx = await setupTestServer();
    const rel = "projects/llm-wiki/work/2026-09-14-missing-fields/spec.md";

    async function callWrite(args: Record<string, unknown>, id: number) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "wiki_workitem_write", arguments: args },
        }),
      });
      const body = (await res.json()) as {
        error?: { code?: number; message?: string };
        result?: {
          isError?: boolean;
          structuredContent?: { ok?: boolean; error?: string; path?: string; writer_id?: string };
        };
      };
      return {
        status: res.status,
        jsonrpcError: body.error,
        isError: body.result?.isError,
        structured: body.result?.structuredContent,
        raw: body,
      };
    }

    async function assertNoWrite(label: string, out: Awaited<ReturnType<typeof callWrite>>) {
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      await expect(readFile(join(ctx.vault, rel), "utf8"), label).rejects.toThrow();
    }

    try {
      await assertNoWrite("missing path", await callWrite({ content: "should not write\n" }, 90));
      await assertNoWrite("missing content", await callWrite({ path: rel }, 91));
      await assertNoWrite("empty path", await callWrite({ path: "", content: "should not write\n" }, 92));
      await assertNoWrite("empty content", await callWrite({ path: rel, content: "" }, 93));
      const whitespace = await callWrite({ path: "   ", content: "should not write\n" }, 94);
      await assertNoWrite("whitespace path", whitespace);
      expect(whitespace.isError).toBe(true);
      expect(whitespace.structured?.error).toBe("USAGE");
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP PATH_DENIED for inbox/ and raw/ with no file written", async () => {
    const ctx = await setupTestServer();
    const logBefore = await readFile(join(ctx.vault, "log.md"), "utf8");

    async function callWrite(path: string, id: number) {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "wiki_workitem_write",
            arguments: { path, content: "should not write\n" },
          },
        }),
      });
      const body = (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: { ok?: boolean; error?: string; path?: string; writer_id?: string };
        };
      };
      return { status: res.status, result: body.result, raw: body };
    }

    async function assertDenied(label: string, rel: string, id: number) {
      const out = await callWrite(rel, id);
      expect(out.status, label).toBe(200);
      expect(out.result?.isError, label).toBe(true);
      expect(out.result?.structuredContent?.ok, label).toBe(false);
      expect(out.result?.structuredContent?.error, label).toBe("PATH_DENIED");
      expect(out.result?.structuredContent?.writer_id, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      await expect(readFile(join(ctx.vault, rel), "utf8"), label).rejects.toThrow();
      expect(await readFile(join(ctx.vault, "log.md"), "utf8"), label).toBe(logBefore);
    }

    try {
      await assertDenied("inbox/", "inbox/not-a-work-item.md", 16);
      await assertDenied("raw/", "raw/transcripts/nope-workitem.md", 17);
    } finally {
      await ctx.close();
    }
  });
});
