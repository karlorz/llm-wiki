import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS } from "../src/mcp-instructions.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { makeTempVault } from "./helpers.js";

async function setupTestServer(options?: { gateReady?: boolean }) {
  const vault = await makeTempVault();
  const token = "test-token";
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const gate = new ReconcileGate(async () => undefined);
  if (options?.gateReady !== false) {
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

const MCP_INSTRUCTIONS_BLOCK =
  /<!-- mcp-instructions:begin -->\r?\n([\s\S]*?)\r?\n<!-- mcp-instructions:end -->/;

function extractMcpInstructionsBlock(markdown: string): string | null {
  const match = markdown.match(MCP_INSTRUCTIONS_BLOCK);
  return match ? match[1].replace(/\r\n/g, "\n").trim() : null;
}

describe("C5 compact activation over MCP and wiki_context", () => {
  it("extracted marker block from canonical activation.md matches MCP_INSTRUCTIONS exactly", () => {
    const canonicalPath = join(__dirname, "../../skills/using-skillwiki/activation.md");
    const content = readFileSync(canonicalPath, "utf8");
    const lf = content.replace(/\r\n/g, "\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(extractMcpInstructionsBlock(content), "canonical activation.md must contain mcp-instructions markers").not.toBeNull();
    expect(extractMcpInstructionsBlock(lf)).toBe(MCP_INSTRUCTIONS.trim());
    expect(extractMcpInstructionsBlock(crlf)).toBe(MCP_INSTRUCTIONS.trim());
  });

  it("JSON-RPC initialize returns instructions containing fail-closed, CAS, and capture kinds", async () => {
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
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          instructions?: string;
          protocolVersion?: string;
          serverInfo?: { name: string; version: string };
        };
      };

      const instructions = body.result?.instructions;
      expect(instructions, "initialize result must contain instructions").toBeDefined();
      expect(typeof instructions).toBe("string");

      // Verify bounds
      expect(instructions!.length).toBeGreaterThan(500);
      expect(instructions!.length).toBeLessThanOrEqual(2048);

      // Verify essential coverage
      expect(instructions).toContain("Fail-Closed Boundary");
      expect(instructions).toContain("CAS Protocol");
      expect(instructions).toContain("base_sha256");
      expect(instructions).toContain("FILE_CHANGED");
      expect(instructions).toContain("task | idea | bug | note");
      expect(instructions).toContain("[REDACTED:<kind>]");
      expect(instructions).toContain("Three-Plane");
    } finally {
      await ctx.close();
    }
  });

  it("wiki_context returns authenticated hostId as writer_id, bounded projects, and metadata", async () => {
    const ctx = await setupTestServer();
    try {
      // Seed two projects in temp vault with active work dirs
      // Project 1: alpha with 6 work dirs (should cap at 5 newest)
      const alphaWork = join(ctx.vault, "projects/alpha/work");
      await mkdir(alphaWork, { recursive: true });
      const workDirsAlpha = [
        "2026-09-01-task-a",
        "2026-09-02-task-b",
        "2026-09-03-task-c",
        "2026-09-04-task-d",
        "2026-09-05-task-e",
        "2026-09-06-task-f",
      ];
      for (const d of workDirsAlpha) {
        await mkdir(join(alphaWork, d), { recursive: true });
      }

      // Project 2: beta with 2 work dirs
      const betaWork = join(ctx.vault, "projects/beta/work");
      await mkdir(betaWork, { recursive: true });
      const workDirsBeta = ["2026-08-10-item-1", "2026-08-20-item-2"];
      for (const d of workDirsBeta) {
        await mkdir(join(betaWork, d), { recursive: true });
      }

      // Project 3: gamma with no work dir
      await mkdir(join(ctx.vault, "projects/gamma"), { recursive: true });
      await writeFile(join(ctx.vault, "projects/gamma/README.md"), "# Gamma\n");

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
            name: "wiki_context",
            arguments: {},
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          structuredContent?: {
            ok: boolean;
            projects: Array<{ slug: string; active_work: string[] }>;
            writer_id: string;
            reconcile_ready: boolean;
            tools: string[];
            cas_protocol: string;
            capture_kinds: string[];
            compact_activation?: {
              instructions_sha256: string;
              instructions_bytes: number;
            };
          };
          content?: Array<{ type: string; text: string }>;
        };
      };

      const sc = body.result?.structuredContent;
      expect(sc).toBeDefined();
      expect(sc?.ok).toBe(true);
      expect(sc?.writer_id).toBe("macos-dev");
      expect(sc?.reconcile_ready).toBe(true);
      expect(sc?.capture_kinds).toEqual(["task", "idea", "bug", "note"]);
      expect(sc?.cas_protocol).toContain("base_sha256");

      // Verify compact_activation digest and byte length
      expect(sc?.compact_activation).toBeDefined();
      const expectedDigest = createHash("sha256").update(MCP_INSTRUCTIONS).digest("hex");
      expect(sc?.compact_activation?.instructions_sha256).toBe(expectedDigest);
      expect(sc?.compact_activation?.instructions_bytes).toBe(Buffer.byteLength(MCP_INSTRUCTIONS));

      // Verify tools list includes all 9 tools
      expect(sc?.tools).toBeDefined();
      expect(sc?.tools).toContain("wiki_context");
      expect(sc?.tools).toContain("wiki_status");
      expect(sc?.tools).toContain("wiki_query");
      expect(sc?.tools).toContain("wiki_read_page");
      expect(sc?.tools).toContain("wiki_capture");
      expect(sc?.tools.length).toBe(9);

      // Verify projects
      expect(sc?.projects).toBeDefined();
      const alphaProj = sc?.projects.find((p) => p.slug === "alpha");
      expect(alphaProj).toBeDefined();
      // Cap at 5 newest descending
      expect(alphaProj?.active_work.length).toBe(5);
      expect(alphaProj?.active_work).toEqual([
        "2026-09-06-task-f",
        "2026-09-05-task-e",
        "2026-09-04-task-d",
        "2026-09-03-task-c",
        "2026-09-02-task-b",
      ]);

      const betaProj = sc?.projects.find((p) => p.slug === "beta");
      expect(betaProj).toBeDefined();
      expect(betaProj?.active_work).toEqual(["2026-08-20-item-2", "2026-08-10-item-1"]);

      const gammaProj = sc?.projects.find((p) => p.slug === "gamma");
      expect(gammaProj).toBeDefined();
      expect(gammaProj?.active_work).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_context HTTP without bearer is 401 and writes nothing", async () => {
    const ctx = await setupTestServer();
    const alphaBefore = await readFile(join(ctx.vault, "concepts/alpha.md"), "utf8");
    const logBefore = await readFile(join(ctx.vault, "log.md"), "utf8");
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      const body = (await res.json()) as {
        error?: string;
        result?: { structuredContent?: { writer_id?: string; projects?: unknown } };
      };
      expect(body.error).toBe("unauthorized");
      expect(body.result?.structuredContent?.writer_id).toBeUndefined();
      expect(body.result?.structuredContent?.projects).toBeUndefined();
      expect(await readFile(join(ctx.vault, "concepts/alpha.md"), "utf8")).toBe(alphaBefore);
      expect(await readFile(join(ctx.vault, "log.md"), "utf8")).toBe(logBefore);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_context HTTP unknown bearer is 401 and writes nothing", async () => {
    const ctx = await setupTestServer();
    const alphaBefore = await readFile(join(ctx.vault, "concepts/alpha.md"), "utf8");
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer unknown-not-in-token-map",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 71,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(((await res.json()) as { error?: string }).error).toBe("unauthorized");
      expect(await readFile(join(ctx.vault, "concepts/alpha.md"), "utf8")).toBe(alphaBefore);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_context blocks when gate is not ready", async () => {
    const ctx = await setupTestServer({ gateReady: false });
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
            name: "wiki_context",
            arguments: {},
          },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: {
          structuredContent?: { ok: boolean; error?: string };
          isError?: boolean;
        };
      };
      expect(body.result?.structuredContent?.ok).toBe(false);
      expect(body.result?.structuredContent?.error).toBe("TOOLS_NOT_READY");
      expect(body.result?.isError).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("wiki_context HTTP unknown and empty project fail-closed with no writer_id and no file written", async () => {
    const ctx = await setupTestServer();
    await mkdir(join(ctx.vault, "projects/alpha/work/2026-09-06-task-f"), { recursive: true });
    const logBefore = await readFile(join(ctx.vault, "log.md"), "utf8");
    const alphaBefore = await readFile(join(ctx.vault, "concepts/alpha.md"), "utf8");

    async function callContext(args: Record<string, unknown>, id: number) {
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
          params: { name: "wiki_context", arguments: args },
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
            projects?: unknown;
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

    async function assertNoWrite(label: string, out: Awaited<ReturnType<typeof callContext>>) {
      expect(out.status, label).toBe(200);
      const failedClosed = Boolean(out.jsonrpcError) || out.isError === true || out.structured?.ok === false;
      expect(failedClosed, label).toBe(true);
      expect(out.structured?.ok, label).not.toBe(true);
      expect(out.structured?.writer_id, label).toBeUndefined();
      expect(out.structured?.projects, label).toBeUndefined();
      expect(JSON.stringify(out.raw), label).not.toContain("chatgpt-web");
      expect(await readdir(join(ctx.vault, "raw", "transcripts")), label).toEqual([]);
      expect(await readFile(join(ctx.vault, "log.md"), "utf8"), label).toBe(logBefore);
      expect(await readFile(join(ctx.vault, "concepts/alpha.md"), "utf8"), label).toBe(alphaBefore);
    }

    try {
      await assertNoWrite("unknown project", await callContext({ project: "does-not-exist" }, 80));
      const empty = await callContext({ project: "" }, 81);
      await assertNoWrite("empty project", empty);
      expect(empty.isError).toBe(true);
      expect(empty.structured?.error).toBe("USAGE");
      const whitespace = await callContext({ project: "   " }, 82);
      await assertNoWrite("whitespace project", whitespace);
      expect(whitespace.isError).toBe(true);
      expect(whitespace.structured?.error).toBe("USAGE");
      await assertNoWrite("path-escape project", await callContext({ project: "../outside" }, 84));
    } finally {
      await ctx.close();
    }
  });
});
