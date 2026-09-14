import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { MAX_READ_PAGE_BYTES } from "../src/tools/reads.js";
import { makeS3Store, makeTempVault } from "./helpers.js";

async function setupTestServer(opts?: { seedLogS3?: boolean; auditFile?: string }) {
  const vault = await makeTempVault();
  const token = "test-token";
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const gate = new ReconcileGate(async () => undefined);
  await gate.runFirst();
  const s3 = opts?.seedLogS3
    ? makeS3Store({ "log.md": await readFile(join(vault, "log.md"), "utf8") })
    : undefined;
  const server = await startMcpHttpServer({
    bind: "127.0.0.1",
    port: 0,
    vaultDir: vault,
    tokenMap: new Map([[hash, "macos-dev"]]),
    gate,
    putObject: s3?.putObject ?? (async () => undefined),
    getObject: s3?.getObject,
    auditFile: opts?.auditFile,
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

  it("wiki_log_append HTTP missing content and bad operation_id fail-closed with log unchanged", async () => {
    const ctx = await setupTestServer();
    const before = await readFile(join(ctx.vault, "log.md"), "utf8");

    async function callAppend(args: Record<string, unknown>, id: number) {
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
          params: { name: "wiki_log_append", arguments: args },
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

    async function assertNoAppend(label: string, out: Awaited<ReturnType<typeof callAppend>>) {
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      expect(await readFile(join(ctx.vault, "log.md"), "utf8"), label).toBe(before);
    }

    try {
      await assertNoAppend("missing content", await callAppend({}, 80));
      await assertNoAppend("empty content", await callAppend({ content: "" }, 81));
      const whitespace = await callAppend({ content: "   " }, 82);
      await assertNoAppend("whitespace content", whitespace);
      expect(whitespace.isError).toBe(true);
      expect(whitespace.structured?.error).toBe("USAGE");
      await assertNoAppend(
        "bad operation_id",
        await callAppend({ content: "should not append", operation_id: "not-64-hex" }, 83),
      );
    } finally {
      await ctx.close();
    }
  });

  it("wiki_capture HTTP invalid kind and missing fields fail-closed with no transcript written", async () => {
    const ctx = await setupTestServer();
    const transcriptDir = join(ctx.vault, "raw", "transcripts");

    async function callCapture(args: Record<string, unknown>, id: number) {
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
          params: { name: "wiki_capture", arguments: args },
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

    async function assertNoWrite(label: string, out: Awaited<ReturnType<typeof callCapture>>) {
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.path, label).toBeUndefined();
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      expect(await readdir(transcriptDir), label).toEqual([]);
    }

    try {
      await assertNoWrite(
        "invalid kind",
        await callCapture(
          { kind: "session-log", project: "llm-wiki", title: "should-not-write", content: "no file" },
          70,
        ),
      );
      await assertNoWrite(
        "missing kind",
        await callCapture({ project: "llm-wiki", title: "should-not-write", content: "no file" }, 71),
      );
      await assertNoWrite(
        "missing title",
        await callCapture({ kind: "note", project: "llm-wiki", content: "no file" }, 72),
      );
      await assertNoWrite(
        "missing content",
        await callCapture({ kind: "note", project: "llm-wiki", title: "should-not-write" }, 73),
      );
      await assertNoWrite(
        "missing project",
        await callCapture({ kind: "note", title: "should-not-write", content: "no file" }, 74),
      );
      await assertNoWrite(
        "empty title",
        await callCapture({ kind: "note", project: "llm-wiki", title: "", content: "no file" }, 75),
      );
      const whitespace = await callCapture(
        { kind: "note", project: "llm-wiki", title: "   ", content: "no file" },
        76,
      );
      await assertNoWrite("whitespace title", whitespace);
      expect(whitespace.isError).toBe(true);
      expect(whitespace.structured?.error).toBe("USAGE");
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP CAS: stale base_sha256 is FILE_CHANGED and writes nothing", async () => {
    const ctx = await setupTestServer();
    const rel = "projects/llm-wiki/work/2026-09-14-http-cas/spec.md";
    const original = "---\nstatus: planned\n---\nold\n";
    const next = "---\nstatus: in-progress\n---\nnew\n";
    const originalSha = createHash("sha256").update(Buffer.from(original, "utf8")).digest("hex");
    await mkdir(join(ctx.vault, "projects/llm-wiki/work/2026-09-14-http-cas"), { recursive: true });
    await writeFile(join(ctx.vault, rel), original, "utf8");
    try {
      const stale = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "wiki_workitem_write",
            arguments: { path: rel, content: next, base_sha256: "00".repeat(32) },
          },
        }),
      });
      expect(stale.status).toBe(200);
      const staleBody = (await stale.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            ok?: boolean;
            error?: string;
            currentVersion?: string;
            path?: string;
            writer_id?: string;
          };
          content?: Array<{ type: string; text: string }>;
        };
      };
      const staleSc = staleBody.result?.structuredContent;
      expect(staleBody.result?.isError).toBe(true);
      expect(staleSc?.ok).toBe(false);
      expect(staleSc?.error).toBe("FILE_CHANGED");
      expect(staleSc?.path).toBe(rel);
      expect(staleSc?.currentVersion).toBe(`sha256:${originalSha}`);
      expect(staleSc?.writer_id).toBeUndefined();
      expect(JSON.stringify(staleBody)).not.toContain("chatgpt-web");
      expect(JSON.stringify(staleSc)).not.toMatch(/Bearer|sk-/);
      expect(JSON.parse(staleBody.result?.content?.[0]?.text ?? "{}")).toEqual(staleSc);
      expect(await readFile(join(ctx.vault, rel), "utf8")).toBe(original);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_page_publish HTTP missing content or target fail-closed with no file written", async () => {
    const ctx = await setupTestServer();
    const target = "concepts/should-not-publish.md";
    const existing = "concepts/alpha.md";
    const existingBefore = await readFile(join(ctx.vault, existing), "utf8");
    const logBefore = await readFile(join(ctx.vault, "log.md"), "utf8");

    async function callPublish(args: Record<string, unknown>, id: number) {
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
          params: { name: "wiki_page_publish", arguments: args },
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

    async function assertNoWrite(label: string, out: Awaited<ReturnType<typeof callPublish>>) {
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      await expect(readFile(join(ctx.vault, target), "utf8"), label).rejects.toThrow();
      expect(await readFile(join(ctx.vault, existing), "utf8"), label).toBe(existingBefore);
      expect(await readFile(join(ctx.vault, "log.md"), "utf8"), label).toBe(logBefore);
    }

    try {
      await assertNoWrite("missing path", await callPublish({ content: "should not write\n" }, 90));
      await assertNoWrite("missing content", await callPublish({ path: existing }, 91));
      await assertNoWrite("empty path", await callPublish({ path: "", content: "should not write\n" }, 92));
      await assertNoWrite("empty content", await callPublish({ path: existing, content: "" }, 93));
      const whitespacePath = await callPublish({ path: "   ", content: "should not write\n" }, 94);
      await assertNoWrite("whitespace path", whitespacePath);
      expect(whitespacePath.isError).toBe(true);
      expect(whitespacePath.structured?.error).toBe("USAGE");
    } finally {
      await ctx.close();
    }
  });

  it("wiki_status HTTP unknown host-id fail-closed with no other-host leak", async () => {
    const ctx = await setupTestServer();
    await mkdir(join(ctx.vault, "projects/llm-wiki/architecture"), { recursive: true });
    await writeFile(
      join(ctx.vault, "projects/llm-wiki/architecture/fleet.yaml"),
      `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [s3, github]
    protected: false
    identity:
      hostnames: [macos-dev]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
`,
      "utf8",
    );
    const logBefore = await readFile(join(ctx.vault, "log.md"), "utf8");

    async function callStatus(args: Record<string, unknown>, id: number) {
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
          params: { name: "wiki_status", arguments: args },
        }),
      });
      const body = (await res.json()) as {
        error?: { code?: number; message?: string };
        result?: {
          isError?: boolean;
          structuredContent?: {
            ok?: boolean;
            error?: string;
            writer_id?: string;
            host_id?: string;
            fleet?: { host_id?: string; identity_status?: string };
          };
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

    async function assertNoLeak(label: string, out: Awaited<ReturnType<typeof callStatus>>) {
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(out.structured?.host_id, label).toBeUndefined();
      expect(out.structured?.fleet, label).toBeUndefined();
      const dumped = JSON.stringify(out.raw);
      expect(dumped, label).not.toContain("chatgpt-web");
      expect(dumped, label).not.toContain("sg01");
      expect(dumped, label).not.toContain("snapshotter");
      expect(await readFile(join(ctx.vault, "log.md"), "utf8"), label).toBe(logBefore);
    }

    try {
      await assertNoLeak("other host-id", await callStatus({ host_id: "sg01" }, 40));
      await assertNoLeak("unknown host-id", await callStatus({ host_id: "not-a-fleet-host" }, 41));
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP missing and empty project fail-closed with no file written", async () => {
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
        error?: { code?: number; message?: string };
        result?: {
          isError?: boolean;
          structuredContent?: { ok?: boolean; error?: string; path?: string; writer_id?: string };
        };
      };
      return { status: res.status, jsonrpcError: body.error, isError: body.result?.isError, structured: body.result?.structuredContent, raw: body };
    }

    async function assertNoWrite(label: string, rel: string, id: number) {
      const out = await callWrite(rel, id);
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      await expect(readFile(join(ctx.vault, rel), "utf8"), label).rejects.toThrow();
      expect(await readFile(join(ctx.vault, "log.md"), "utf8"), label).toBe(logBefore);
    }

    try {
      await assertNoWrite(
        "empty project slug",
        "projects//work/2026-09-14-missing-project/spec.md",
        50,
      );
      await assertNoWrite(
        "whitespace project slug",
        "projects/ /work/2026-09-14-missing-project/spec.md",
        51,
      );
      await assertNoWrite(
        "missing project slug",
        "projects/work/2026-09-14-missing-project/spec.md",
        52,
      );
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP PATH_DENIED for history/ with no file written", async () => {
    const ctx = await setupTestServer();
    const rel = "projects/llm-wiki/history/specs/old-spec.md";
    try {
      const denied = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 18,
          method: "tools/call",
          params: {
            name: "wiki_workitem_write",
            arguments: { path: rel, content: "should not archive-write\n" },
          },
        }),
      });
      const sc = ((await denied.json()) as {
        result?: { isError?: boolean; structuredContent?: { ok?: boolean; error?: string; writer_id?: string } };
      }).result;
      expect(sc?.isError).toBe(true);
      expect(sc?.structuredContent?.error).toBe("PATH_DENIED");
      expect(sc?.structuredContent?.writer_id).toBeUndefined();
      expect(JSON.stringify(sc)).not.toContain("chatgpt-web");
      await expect(readFile(join(ctx.vault, rel), "utf8")).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP rejects live credential patterns without writing", async () => {
    const ctx = await setupTestServer();
    const rel = "projects/llm-wiki/knowledge.md";
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
          id: 19,
          method: "tools/call",
          params: {
            name: "wiki_workitem_write",
            arguments: {
              path: rel,
              content: "Authorization: Bearer sk-live-super-secret-token-value-123456\n",
            },
          },
        }),
      });
      const sc = ((await res.json()) as {
        result?: { isError?: boolean; structuredContent?: { ok?: boolean; error?: string; writer_id?: string } };
      }).result;
      expect(sc?.isError).toBe(true);
      expect(sc?.structuredContent?.ok).toBe(false);
      expect(sc?.structuredContent?.error).toBe("SENSITIVE_CONTENT_DETECTED");
      expect(sc?.structuredContent?.writer_id).toBeUndefined();
      await expect(readFile(join(ctx.vault, rel), "utf8")).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP create: omit base_sha256 when path is absent", async () => {
    const ctx = await setupTestServer();
    const rel = "projects/llm-wiki/knowledge.md";
    const body = "---\ntitle: k\n---\nbody\n";
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
          id: 15,
          method: "tools/call",
          params: {
            name: "wiki_workitem_write",
            arguments: { path: rel, content: body },
          },
        }),
      });
      const sc = ((await res.json()) as {
        result?: { structuredContent?: { ok?: boolean; path?: string; writer_id?: string } };
      }).result?.structuredContent;
      expect(sc?.ok).toBe(true);
      expect(sc?.path).toBe(rel);
      expect(sc?.writer_id).toBeUndefined();
      expect(await readFile(join(ctx.vault, rel), "utf8")).toBe(body);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_workitem_write HTTP create with base_sha256 when path is absent is FILE_CHANGED and writes nothing", async () => {
    const ctx = await setupTestServer();
    const rel = "projects/llm-wiki/knowledge.md";
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
          id: 28,
          method: "tools/call",
          params: {
            name: "wiki_workitem_write",
            arguments: { path: rel, content: "should not create\n", base_sha256: "00".repeat(32) },
          },
        }),
      });
      const sc = ((await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: { ok?: boolean; error?: string; currentVersion?: string; writer_id?: string };
        };
      }).result;
      expect(res.status).toBe(200);
      expect(sc?.isError).toBe(true);
      expect(sc?.structuredContent?.ok).toBe(false);
      expect(sc?.structuredContent?.error).toBe("FILE_CHANGED");
      expect(sc?.structuredContent?.currentVersion).toBe("sha256:absent");
      expect(sc?.structuredContent?.writer_id).toBeUndefined();
      expect(JSON.stringify(sc)).not.toContain("chatgpt-web");
      await expect(readFile(join(ctx.vault, rel), "utf8")).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("wiki_status HTTP receipt uses host-id writer_id and known fleet identity", async () => {
    const ctx = await setupTestServer();
    await mkdir(join(ctx.vault, "projects/llm-wiki/architecture"), { recursive: true });
    await writeFile(
      join(ctx.vault, "projects/llm-wiki/architecture/fleet.yaml"),
      `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [s3, github]
    protected: false
    identity:
      hostnames: [macos-dev]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
`,
      "utf8",
    );
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
          id: 23,
          method: "tools/call",
          params: { name: "wiki_status", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          structuredContent?: {
            ok?: boolean;
            writer_id?: string;
            host_id?: string;
            fleet?: {
              identity_status?: string;
              manifest_loaded?: boolean;
              host_id?: string;
              source?: string;
            };
          };
          content?: Array<{ type: string; text: string }>;
        };
      };
      const sc = body.result?.structuredContent;
      expect(sc?.ok).toBe(true);
      expect(sc?.writer_id).toBe("macos-dev");
      expect(sc?.host_id).toBe("macos-dev");
      expect(sc?.writer_id).not.toBe("chatgpt-web");
      expect(sc?.host_id).not.toBe("chatgpt-web");
      expect(sc?.fleet).toBeDefined();
      expect(sc?.fleet?.identity_status).toBe("known");
      expect(sc?.fleet?.manifest_loaded).toBe(true);
      expect(sc?.fleet?.host_id).toBe("macos-dev");
      expect(sc?.fleet?.source).toBe("host-id");
      expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toEqual(sc);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_read_page HTTP missing path is FILE_NOT_FOUND fail-closed", async () => {
    const ctx = await setupTestServer();
    const rel = "concepts/missing-http-read.md";
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
          id: 26,
          method: "tools/call",
          params: { name: "wiki_read_page", arguments: { path: rel } },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            ok?: boolean;
            error?: string;
            path?: string;
            markdown?: string;
            writer_id?: string;
          };
        };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.structuredContent?.ok).toBe(false);
      expect(body.result?.structuredContent?.error).toBe("FILE_NOT_FOUND");
      expect(body.result?.structuredContent?.path).toBe(rel);
      expect(body.result?.structuredContent?.markdown).toBeUndefined();
      expect(body.result?.structuredContent?.writer_id).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("wiki_log_append HTTP receipt has event_path and does not invent writer_id", async () => {
    const ctx = await setupTestServer({ seedLogS3: true });
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
          id: 5,
          method: "tools/call",
          params: {
            name: "wiki_log_append",
            arguments: { content: "capture | note: http log receipt" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          structuredContent?: {
            ok?: boolean;
            path?: string;
            event_path?: string;
            s3_verified?: boolean;
            writer_id?: string;
          };
        };
      };
      const sc = body.result?.structuredContent;
      expect(sc?.ok).toBe(true);
      expect(sc?.path).toBe("log.md");
      expect(sc?.s3_verified).toBe(true);
      expect(sc?.event_path).toMatch(/^meta\/log-events\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.json$/);
      expect(sc?.writer_id).toBeUndefined();

      const readRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "wiki_read_page", arguments: { path: sc?.event_path } },
        }),
      });
      const readBody = (await readRes.json()) as {
        result?: { structuredContent?: { ok?: boolean; markdown?: string } };
      };
      expect(readBody.result?.structuredContent?.ok).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_capture receipt includes host-id writer_id over HTTP MCP", async () => {
    const auditFile = join(await mkdtemp(join(tmpdir(), "skillwiki-mcp-audit-")), "audit.jsonl");
    const ctx = await setupTestServer({ auditFile });
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
          id: 3,
          method: "tools/call",
          params: {
            name: "wiki_capture",
            arguments: {
              kind: "note",
              project: "llm-wiki",
              title: "http receipt writer",
              content: "Host-id receipt body",
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          isError?: boolean;
          structuredContent?: { ok?: boolean; writer_id?: string; path?: string };
          content?: Array<{ type: string; text: string }>;
        };
      };
      const sc = body.result?.structuredContent;
      expect(body.result?.isError).toBeUndefined();
      expect(sc?.ok).toBe(true);
      expect(sc?.writer_id).toBe("macos-dev");
      expect(sc?.writer_id).not.toBe("chatgpt-web");
      expect(sc?.path).toMatch(/^raw\/transcripts\/\d{4}-\d{2}-\d{2}-note-http-receipt-writer\.md$/);
      expect(JSON.parse(body.result?.content?.[0]?.text ?? "{}")).toEqual(sc);

      const readRes = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "wiki_read_page", arguments: { path: sc?.path } },
        }),
      });
      expect(readRes.status).toBe(200);
      const readBody = (await readRes.json()) as {
        result?: { structuredContent?: { ok?: boolean; markdown?: string; path?: string } };
      };
      expect(readBody.result?.structuredContent?.ok).toBe(true);
      expect(readBody.result?.structuredContent?.path).toBe(sc?.path);
      expect(readBody.result?.structuredContent?.markdown).toContain("Host-id receipt body");

      const audit = (await readFile(auditFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { tool?: string; host_id?: string; path?: string; ok?: boolean });
      const captureAudit = audit.find((row) => row.tool === "wiki_capture" && row.ok);
      expect(captureAudit?.host_id).toBe("macos-dev");
      expect(captureAudit?.path).toBe(sc?.path);
    } finally {
      await ctx.close();
    }
  });
});
