import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseTokenMap, resolveHostId } from "../src/auth.js";
import {
  formatWhen,
  isConsolePath,
  isConsoleRequestAllowed,
  pageAudit,
  parseAuditLines,
  readAuditLog,
} from "../src/console.js";
import { InMemoryOAuthStore, type OAuthStore } from "../src/oauth-store.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import * as tokenMapMod from "../src/token-map.js";
import { makeTempVault } from "./helpers.js";

async function startConsole(opts: {
  tokenMapYaml: string;
  auditLines?: string[];
  auditFileIsDir?: boolean;
  oauthStore?: OAuthStore;
  oauth?: {
    enabled?: boolean;
    passwordHash?: string;
    stateDir?: string;
    store?: OAuthStore;
  };
}): Promise<{
  port: number;
  close: () => Promise<void>;
  tokenMapPath: string;
  auditFile: string;
  stateDir?: string;
  oauthConfig?: import("../src/oauth.js").OAuthConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), "skillwiki-mcp-console-"));
  const tokenMapPath = join(root, "tokens.yaml");
  const auditFile = join(root, "audit.jsonl");
  await writeFile(tokenMapPath, opts.tokenMapYaml, "utf8");
  if (opts.auditFileIsDir) {
    await mkdir(auditFile);
  } else {
    await writeFile(auditFile, (opts.auditLines ?? []).join("\n") + (opts.auditLines?.length ? "\n" : ""), "utf8");
  }
  const vault = await makeTempVault();
  const gate = new ReconcileGate(async () => undefined);
  await gate.runFirst();
  const tokenMap = parseTokenMap(opts.tokenMapYaml);
  const oauthConfig: import("../src/oauth.js").OAuthConfig | undefined = opts.oauth
    ? {
        enabled: opts.oauth.enabled ?? true,
        passwordHash: opts.oauth.passwordHash,
        stateDir: opts.oauth.stateDir,
        writers: [{ client_id: "*", writer_id: "oauth-user" }],
        store: opts.oauth.store,
      }
    : opts.oauthStore
      ? {
          enabled: true,
          passwordHash: "dummy-hash",
          writers: [{ client_id: "*", writer_id: "oauth-user" }],
          store: opts.oauthStore,
        }
      : undefined;

  const server = await startMcpHttpServer({
    bind: "127.0.0.1",
    port: 0,
    vaultDir: vault,
    tokenMap,
    tokenMapPath,
    auditFile,
    gate,
    putObject: async () => undefined,
    oauth: oauthConfig,
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    tokenMapPath,
    auditFile,
    stateDir: opts.oauth?.stateDir,
    oauthConfig,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hexRange(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, i) => (from + i).toString(16).padStart(2, "0"));
}

/** Bounded leftover encodings already landed. Do not extend through %90–%ff. */
const HA_CONFIRM_ENC = hexRange(0x3f, 0x8f);

describe("isConsoleRequestAllowed", () => {
  it("allows loopback plus localhost Host", () => {
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:8801" },
      }),
    ).toBe(true);
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "::1" },
        headers: { host: "localhost:8801" },
      }),
    ).toBe(true);
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "::1" },
        headers: { host: "[::1]:8801" },
      }),
    ).toBe(true);
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "::ffff:127.0.0.1" },
        headers: { host: ["127.0.0.1:8801"] },
      }),
    ).toBe(true);
  });

  it("treats any /console prefix as a console path", () => {
    expect(isConsolePath("/console")).toBe(true);
    expect(isConsolePath("/console/")).toBe(true);
    expect(isConsolePath("/console/issue")).toBe(true);
    expect(isConsolePath("/console/unknown")).toBe(true);
    expect(isConsolePath("/mcp")).toBe(false);
    expect(isConsolePath("/console-not")).toBe(false);
    expect(isConsolePath("/CONSOLE")).toBe(false);
    expect(isConsolePath("/Console")).toBe(false);
    expect(isConsolePath("/CONSOLE/issue")).toBe(false);
    expect(isConsolePath("/mcp/console")).toBe(false);
  });

  it("refuses a public Host even from loopback (Caddy-proxied)", () => {
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "wiki.karldigi.dev" },
      }),
    ).toBe(false);
  });

  it("refuses a non-loopback remote even with localhost Host", () => {
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "203.0.113.10" },
        headers: { host: "localhost" },
      }),
    ).toBe(false);
  });

  it("refuses loopback when Host is missing or empty", () => {
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
      }),
    ).toBe(false);
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "" },
      }),
    ).toBe(false);
    expect(
      isConsoleRequestAllowed({
        socket: { remoteAddress: "::1" },
        headers: { host: "   " },
      }),
    ).toBe(false);
  });
});

describe("console audit helpers", () => {
  it("parseAuditLines skips malformed and incomplete rows", () => {
    const rows = parseAuditLines(
      [
        "{not json",
        JSON.stringify({ ts: "2026-09-14T00:00:00.000Z" }),
        JSON.stringify({
          ts: "2026-09-14T00:00:01.000Z",
          host_id: "macos-dev",
          tool: "wiki_status",
          ok: true,
          ms: 4,
        }),
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("wiki_status");
  });

  it("parseAuditLines ignores extra keys and treats omitted ok as true", () => {
    const rows = parseAuditLines(
      [
        JSON.stringify({
          ts: "2026-09-14T00:00:02.000Z",
          host_id: "macos-dev",
          tool: "wiki_query",
          path: "concepts/alpha.md",
          extra: "ignored",
          writer_id: "chatgpt-web",
          ms: 7,
        }),
        JSON.stringify({
          ts: "2026-09-14T00:00:03.000Z",
          host_id: "sg02",
          tool: "wiki_context",
          ok: false,
          error: "TOOLS_NOT_READY",
          ms: 3,
        }),
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ok).toBe(true);
    expect(rows[0]?.path).toBe("concepts/alpha.md");
    expect(rows[0]?.tool).toBe("wiki_query");
    expect(rows[0]).not.toHaveProperty("extra");
    expect(rows[0]).not.toHaveProperty("writer_id");
    expect(rows[1]?.ok).toBe(false);
    expect(rows[1]?.error).toBe("TOOLS_NOT_READY");
    expect(rows[1]?.host_id).toBe("sg02");
  });

  it("pageAudit clamps page and newest-first", () => {
    const rows = [
      { ts: "2026-09-14T00:00:00.000Z", host_id: "a", tool: "old", ok: true, ms: 1 },
      { ts: "2026-09-14T00:00:01.000Z", host_id: "a", tool: "new", ok: true, ms: 2 },
    ];
    expect(pageAudit(rows, 0, 1).slice[0]?.tool).toBe("new");
    expect(pageAudit(rows, 1.5, 1).page).toBe(1);
    expect(pageAudit(rows, 99, 1).page).toBe(2);
    expect(pageAudit([], 3).pages).toBe(1);
  });

  it("formatWhen keeps invalid ISO and formats valid instants", () => {
    expect(formatWhen("not-a-date")).toBe("not-a-date");
    expect(formatWhen("2026-09-14T00:00:24.000Z")).not.toBe("2026-09-14T00:00:24.000Z");
  });

  it("readAuditLog treats a directory as a load error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skillwiki-audit-dir-"));
    const loaded = readAuditLog(dir);
    expect(loaded.rows).toEqual([]);
    expect(loaded.error).toBe("Could not load audit. Retry.");
    expect(readAuditLog(undefined).rows).toEqual([]);
  });
});

describe("HTTP /console", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves HTML on GET /console from loopback localhost Host", async () => {
    const existing = hashToken("seed-token");
    const ctx = await startConsole({ tokenMapYaml: `${existing}: macos-dev\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Host-id bearers");
      expect(html).toContain("macos-dev");
      expect(html).toContain(`••••${existing.slice(-4)}`);
      expect(html).toContain("Enabled");
      expect(html).toContain("Fleet hosts");
      expect(html).toContain("MCP audit");
      expect(html).not.toContain("Kimi");
      expect(html).not.toContain("seed-token");

      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(slash.status).toBe(200);
      expect(await slash.text()).toContain("Host-id bearers");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for /console when Host is the public vhost", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, path: "/console", headers: { Host: "wiki.karldigi.dev" } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(body).not.toContain("Host-id bearers");
    } finally {
      await ctx.close();
    }
  });

  it("serves GET /console when Host is [::1]", async () => {
    const existing = hashToken("seed-token");
    const ctx = await startConsole({ tokenMapYaml: `${existing}: macos-dev\n` });
    try {
      for (const host of ["[::1]", "[::1]:8801"]) {
        const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: ctx.port, path: "/console", headers: { Host: host } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status, host).toBe(200);
        expect(body, host).toContain("Host-id bearers");
        expect(body, host).toContain("macos-dev");
        expect(body, host).not.toContain("seed-token");
      }
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for POST /console/issue when Host is the public vhost", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/issue",
            headers: {
              Host: "wiki.karldigi.dev",
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength("host_id=sg03"),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.end("host_id=sg03");
      });
      expect(status).toBe(404);
      expect(body).toContain("not_found");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for POST /console/revoke when Host is the public vhost", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const bodyText = "host_id=sg02&confirm=1";
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/revoke",
            headers: {
              Host: "wiki.karldigi.dev",
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(body).toContain("not_found");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for POST /console/issue when Host is public even with X-Forwarded-For loopback", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/issue",
            headers: {
              Host: "wiki.karldigi.dev",
              "X-Forwarded-For": "127.0.0.1",
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength("host_id=sgxff01"),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.end("host_id=sgxff01");
      });
      expect(status).toBe(404);
      expect(body).toContain("not_found");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it("serves GET /console when Host is loopback even with X-Forwarded-For public", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, body } = await new Promise<{
        status: number;
        contentType: string;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "GET",
            path: "/console",
            headers: {
              Host: "127.0.0.1",
              "X-Forwarded-For": "8.8.8.8",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: String(res.headers["content-type"] ?? ""),
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("sg02");
      expect(body).not.toContain(keepRaw);
      expect(body).not.toContain("not_found");
    } finally {
      await ctx.close();
    }
  });

  it("returns JSON 404 for GET /CONSOLE because the console path is case-sensitive", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/CONSOLE`, { redirect: "manual" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = await res.json();
      expect(body).toEqual({ error: "not_found" });
    } finally {
      await ctx.close();
    }
  });

  it("serves GET /console when Host is localhost without a port", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, body } = await new Promise<{
        status: number;
        contentType: string;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "GET",
            path: "/console",
            headers: { Host: "localhost" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: String(res.headers["content-type"] ?? ""),
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("sg02");
      expect(body).not.toContain(keepRaw);
    } finally {
      await ctx.close();
    }
  });

  it("leaves /mcp unchanged (still 401 without a bearer)", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id, shows the bearer once, persists only the hash", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
        redirect: "manual",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      const match = html.match(/data-once-bearer="([^"]+)"/);
      expect(match?.[1]).toBeTruthy();
      const raw = match![1];
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(html).toContain("I saved it");
      expect(html).toContain('id="copy-bearer"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('history.replaceState(null, "", "/console")');
      expect(html).toContain("sg03");
      expect(html).not.toMatch(/id="host_id"[^>]*value=/);

      const yaml = readFileSync(ctx.tokenMapPath, "utf8");
      expect(yaml).not.toContain(raw);
      const map = parseTokenMap(yaml);
      expect(map.size).toBe(1);
      expect([...map.values()]).toEqual(["sg03"]);
      const hash = [...map.keys()][0]!;
      expect(hash).toBe(hashToken(raw));
      expect(resolveHostId(raw, map)).toBe("sg03");
      expect(html).toContain(`••••${hash.slice(-4)}`);

      const logged = spy.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain(raw);
    } finally {
      await ctx.close();
    }
  });

  it("includes a skip-to-main link on GET /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<a class="skip" href="#main">Skip to main</a>');
      expect(html).toContain('<main id="main">');
      expect(html).toContain('<meta name="color-scheme" content="dark">');
      expect(html).toContain('aria-current="page"');
      expect(html).toContain("sg02");
      expect(html).not.toContain(keepRaw);
    } finally {
      await ctx.close();
    }
  });

  it("includes a skip-to-main link on HTML 404 /console routes", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/not-a-route`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain('<a class="skip" href="#main">Skip to main</a>');
      expect(html).toContain('<main id="main">');
    } finally {
      await ctx.close();
    }
  });

  it("includes a skip-to-main link on POST /console/issue success HTML", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgskip01",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgskip01");
      expect(html).toContain('<a class="skip" href="#main">Skip to main</a>');
      expect(html).toContain('<main id="main">');
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgskip01");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("uses a console-issued bearer on /mcp with the issued host-id as writer_id", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      const html = await issued.text();
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();

      const denied = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wiki_context", arguments: {} } }),
      });
      expect(denied.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        result?: { structuredContent?: { ok?: boolean; writer_id?: string } };
      };
      expect(body.result?.structuredContent?.ok).toBe(true);
      expect(body.result?.structuredContent?.writer_id).toBe("sg03");
      expect(body.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a console-issued bearer so /mcp returns 401", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      const raw = (await issued.text()).match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();

      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03&confirm=1",
      });
      expect(revoked.status).toBe(200);

      const denied = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(denied.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it("refuses issue without confirm-safe host-id", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=SG03",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toMatch(/data-once-bearer=/);
    } finally {
      await ctx.close();
    }
  });

  it("refuses empty and whitespace host-id on issue with no once-bearer", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      for (const body of ["", "host_id=", "host_id=   ", "host_id=%20%20"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        expect(res.status, body || "(empty body)").toBe(400);
        const html = await res.text();
        expect(html, body || "(empty body)").toContain("Invalid host-id.");
        expect(html, body || "(empty body)").not.toMatch(/data-once-bearer=/);
        expect(html, body || "(empty body)").toContain("0 issued");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it("issues a 63-char host-id and refuses a 64-char host-id", async () => {
    const maxId = `a${"b".repeat(62)}`;
    const tooLong = `a${"b".repeat(63)}`;
    expect(maxId).toHaveLength(63);
    expect(tooLong).toHaveLength(64);
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const ok = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `host_id=${maxId}`,
      });
      expect(ok.status).toBe(200);
      const okHtml = await ok.text();
      expect(okHtml).toContain("1 issued");
      expect(okHtml).toContain(maxId);
      expect(okHtml).toMatch(/data-once-bearer=/);

      const denied = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `host_id=${tooLong}`,
      });
      expect(denied.status).toBe(400);
      const deniedHtml = await denied.text();
      expect(deniedHtml).toContain("Invalid host-id.");
      expect(deniedHtml).not.toMatch(/data-once-bearer=/);
      expect(deniedHtml).toContain("1 issued");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id only with confirm and removes the map line", async () => {
    const raw = "revoke-me-token";
    const hash = hashToken(raw);
    const ctx = await startConsole({ tokenMapYaml: `${hash}: cursor-box\n` });
    try {
      const denied = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=cursor-box",
      });
      expect(denied.status).toBe(400);
      expect(readFileSync(ctx.tokenMapPath, "utf8")).toContain("cursor-box");

      const ok = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=cursor-box&confirm=1",
      });
      expect(ok.status).toBe(200);
      const html = await ok.text();
      expect(html).not.toContain("cursor-box");
      expect(html).toContain("No host-id bearers");
      const yaml = readFileSync(ctx.tokenMapPath, "utf8");
      expect(parseTokenMap(yaml).size).toBe(0);
      expect(html).not.toContain(raw);
    } finally {
      await ctx.close();
    }
  });

  it("refuses empty and whitespace host-id on revoke with confirmation copy", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const body of [
        "confirm=1",
        "host_id=&confirm=1",
        "host_id=   &confirm=1",
        "host_id=%20%20&confirm=1",
      ]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        expect(res.status, body).toBe(400);
        const html = await res.text();
        expect(html, body).toContain("Revoke requires confirmation.");
        expect(html, body).toContain("sg02");
        expect(html, body).toContain("1 issued");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses invalid host-id on revoke with confirmation copy not not-found", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const hostId of ["SG03", "a", "macos_dev", "-sg01"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${encodeURIComponent(hostId)}&confirm=1`,
        });
        expect(res.status, hostId).toBe(400);
        const html = await res.text();
        expect(html, hostId).toContain("Revoke requires confirmation.");
        expect(html, hostId).not.toContain("Host-id not found.");
        expect(html, hostId).toContain("sg02");
        expect(html, hostId).toContain("1 issued");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses revoke unless confirm is exactly 1", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const confirm of ["0", "yes", "true", "1 "]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=sg02&confirm=${encodeURIComponent(confirm)}`,
        });
        expect(res.status, confirm).toBe(400);
        const html = await res.text();
        expect(html, confirm).toContain("Revoke requires confirmation.");
        expect(html, confirm).toContain("sg02");
        expect(html, confirm).toContain("1 issued");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("pages audit newest-first at 20 rows", async () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({
        ts: `2026-09-14T00:00:${String(i).padStart(2, "0")}.000Z`,
        host_id: "macos-dev",
        tool: i === 24 ? "wiki_workitem_write" : "wiki_status",
        path: i === 24 ? "projects/demo/work/x/spec.md" : undefined,
        ok: i % 5 !== 0,
        error: i % 5 === 0 ? "denied" : undefined,
        ms: 10 + i,
      }),
    );
    const ctx = await startConsole({ tokenMapYaml: `${hashToken("t")}: macos-dev\n`, auditLines: lines });
    try {
      const page1 = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(page1).toContain("25 records");
      expect(page1).toContain("1/2");
      expect(page1).toContain("Next");
      expect(page1).toContain('href="/console?page=2"');
      expect(page1).toContain('pattern="[a-z][a-z0-9\\-]{1,62}"');
      expect(page1).toContain("scrollbar-gutter: stable");
      expect(page1).toContain("button, .pager-link, input { transition: none !important; animation: none !important; }");
      expect(page1).toContain("wiki_workitem_write");
      expect(page1).toContain('datetime="2026-09-14T00:00:24.000Z"');
      expect(page1).not.toMatch(/>2026-09-14T00:00:24\.000Z</);
      expect(page1).toContain("projects/demo/work/x/spec.md");
      expect(page1.match(/wiki_status/g)?.length).toBe(19);

      const page2 = await (await fetch(`http://127.0.0.1:${ctx.port}/console?page=2`)).text();
      expect(page2).toContain("2/2");
      expect(page2).toContain("wiki_status");
      expect(page2).not.toContain("wiki_workitem_write");
      expect(page2.match(/wiki_status/g)?.length).toBe(5);
    } finally {
      await ctx.close();
    }
  });

  it("clamps GET /console page=0 and page=999 to first and last audit pages", async () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({
        ts: `2026-09-14T00:00:${String(i).padStart(2, "0")}.000Z`,
        host_id: "macos-dev",
        tool: i === 24 ? "wiki_workitem_write" : "wiki_status",
        path: i === 24 ? "projects/demo/work/x/spec.md" : undefined,
        ok: true,
        ms: 10 + i,
      }),
    );
    const ctx = await startConsole({ tokenMapYaml: `${hashToken("t")}: macos-dev\n`, auditLines: lines });
    try {
      const page0 = await (await fetch(`http://127.0.0.1:${ctx.port}/console?page=0`)).text();
      expect(page0).toContain("1/2");
      expect(page0).toContain("wiki_workitem_write");
      expect(page0).toContain('href="/console?page=2"');
      expect(page0).not.toContain("0/2");

      const overflow = await (await fetch(`http://127.0.0.1:${ctx.port}/console?page=999`)).text();
      expect(overflow).toContain("2/2");
      expect(overflow).not.toContain("wiki_workitem_write");
      expect(overflow.match(/wiki_status/g)?.length).toBe(5);
      expect(overflow).toContain('href="/console?page=1"');

      for (const page of ["-1", "foo", "", "1.5", "2.5"]) {
        const html = await (await fetch(`http://127.0.0.1:${ctx.port}/console?page=${page}`)).text();
        expect(html, `page=${page || "(empty)"}`).toContain("1/2");
        expect(html, `page=${page || "(empty)"}`).not.toContain("1.5/2");
        expect(html, `page=${page || "(empty)"}`).not.toContain("2.5/2");
        expect(html, `page=${page || "(empty)"}`).toContain("wiki_workitem_write");
      }
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue and GET /console/revoke to /console", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      for (const path of ["/console/issue", "/console/revoke"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue?foo=1 and GET /console/revoke?foo=1 to /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?foo=1", "/console/revoke?foo=1", "/console/issue/?foo=1", "/console/revoke/?foo=1"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue?bar=2 and GET /console/issue?foo=1&bar=2 to /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of [
        "/console/issue?bar=2",
        "/console/revoke?bar=2",
        "/console/issue?foo=1&bar=2",
        "/console/revoke?foo=1&bar=2",
      ]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue?bar=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?bar=2`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?bar=2`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke?bar=2 and combined ?foo=1&bar=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of [
        "/console/revoke?bar=2",
        "/console/issue?foo=1&bar=2",
        "/console/revoke?foo=1&bar=2",
      ]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE HEAD PUT PATCH DELETE /console/issue?bar=2 and /console/revoke?bar=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?bar=2", "/console/revoke?bar=2"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        for (const method of ["TRACE", "HEAD"] as const) {
          const { status, location, contentType, cacheControl, body } = await new Promise<{
            status: number;
            location: string | undefined;
            contentType: string | undefined;
            cacheControl: string | undefined;
            body: string;
          }>((resolve, reject) => {
            const req = httpRequest(
              { host: "127.0.0.1", port: ctx.port, method, path },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                  resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    contentType: Array.isArray(res.headers["content-type"])
                      ? res.headers["content-type"][0]
                      : res.headers["content-type"],
                    cacheControl: Array.isArray(res.headers["cache-control"])
                      ? res.headers["cache-control"][0]
                      : res.headers["cache-control"],
                    body: Buffer.concat(chunks).toString("utf8"),
                  }),
                );
              },
            );
            req.on("error", reject);
            req.end();
          });
          expect(status).toBe(404);
          expect(location).toBeUndefined();
          expect(contentType).toMatch(/text\/html/);
          expect(cacheControl).toBe("no-store");
          if (method === "HEAD") {
            expect(body).toBe("");
          } else {
            expect(body).toContain("Not found.");
            expect(body).toContain("sg02");
          }
        }

        for (const method of ["PUT", "PATCH", "DELETE"] as const) {
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method });
          expect(res.status).toBe(404);
          expect(res.headers.get("location")).toBeNull();
          expect(res.headers.get("content-type")).toMatch(/text\/html/);
          expect(res.headers.get("cache-control")).toBe("no-store");
          const html = await res.text();
          expect(html).toContain("Not found.");
          expect(html).toContain("sg02");
          expect(html).not.toContain(keepRaw);
        }
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue?page=2 and GET /console/revoke?page=2 to /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?page=2", "/console/revoke?page=2", "/console/issue/?page=2", "/console/revoke/?page=2"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue?page=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?page=2`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?page=2`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke?page=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?page=2`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?page=2`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue/?page=2 and /console/revoke/?page=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue/?page=2", "/console/revoke/?page=2"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE HEAD PUT PATCH DELETE /console/issue?page=2 and /console/revoke?page=2 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?page=2", "/console/revoke?page=2"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        for (const method of ["TRACE", "HEAD"] as const) {
          const { status, location, contentType, cacheControl, body } = await new Promise<{
            status: number;
            location: string | undefined;
            contentType: string | undefined;
            cacheControl: string | undefined;
            body: string;
          }>((resolve, reject) => {
            const req = httpRequest(
              { host: "127.0.0.1", port: ctx.port, method, path },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () =>
                  resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location,
                    contentType: Array.isArray(res.headers["content-type"])
                      ? res.headers["content-type"][0]
                      : res.headers["content-type"],
                    cacheControl: Array.isArray(res.headers["cache-control"])
                      ? res.headers["cache-control"][0]
                      : res.headers["cache-control"],
                    body: Buffer.concat(chunks).toString("utf8"),
                  }),
                );
              },
            );
            req.on("error", reject);
            req.end();
          });
          expect(status).toBe(404);
          expect(location).toBeUndefined();
          expect(contentType).toMatch(/text\/html/);
          expect(cacheControl).toBe("no-store");
          if (method === "HEAD") {
            expect(body).toBe("");
          } else {
            expect(body).toContain("Not found.");
            expect(body).toContain("sg02");
          }
        }

        for (const method of ["PUT", "PATCH", "DELETE"] as const) {
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method });
          expect(res.status).toBe(404);
          expect(res.headers.get("location")).toBeNull();
          expect(res.headers.get("content-type")).toMatch(/text\/html/);
          expect(res.headers.get("cache-control")).toBe("no-store");
          const html = await res.text();
          expect(html).toContain("Not found.");
          expect(html).toContain("sg02");
          expect(html).not.toContain(keepRaw);
        }
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue?page=1 and GET /console/revoke?page=1 to /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?page=1", "/console/revoke?page=1", "/console/issue/?page=1", "/console/revoke/?page=1"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue?page=1 and /console/revoke?page=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?page=1", "/console/revoke?page=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue?page=0 and GET /console/revoke?page=0 to /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?page=0", "/console/revoke?page=0", "/console/issue/?page=0", "/console/revoke/?page=0"]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue?page=-1 page=999 page=foo page=1.5 to /console", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of [
        "/console/issue?page=-1",
        "/console/revoke?page=-1",
        "/console/issue?page=999",
        "/console/revoke?page=999",
        "/console/issue?page=foo",
        "/console/revoke?page=foo",
        "/console/issue?page=1.5",
        "/console/revoke?page=1.5",
      ]) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue?page=0 and /console/revoke?page=0 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?page=0", "/console/revoke?page=0"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue?page=-1 and clamp queries instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of [
        "/console/issue?page=-1",
        "/console/revoke?page=-1",
        "/console/issue?page=999",
        "/console/revoke?page=999",
        "/console/issue?page=foo",
        "/console/revoke?page=foo",
        "/console/issue?page=1.5",
        "/console/revoke?page=1.5",
      ]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?foo=1`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?foo=1`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?foo=1`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?foo=1`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke?confirm=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of [
        "/console/revoke?confirm=1",
        "/console/issue?confirm=1",
        "/console/revoke?host_id=macos-dev&confirm=1",
        "/console/issue?host_id=sg99",
        "/console/revoke/?confirm=1",
        "/console/issue/?confirm=1",
        "/console/revoke/?host_id=macos-dev&confirm=1",
        "/console/issue/?host_id=sg99",
      ]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toMatch(/data-once-bearer=/);
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for TRACE HEAD PUT PATCH DELETE on /console/revoke?confirm=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of [
        "/console/revoke?confirm=1",
        "/console/issue?confirm=1",
        "/console/issue?host_id=sg99",
        "/console/revoke/?confirm=1",
        "/console/issue/?confirm=1",
        "/console/issue/?host_id=sg99",
      ]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        for (const method of ["TRACE", "HEAD", "PUT", "PATCH", "DELETE"] as const) {
          const { status, location, contentType, cacheControl, body } = await new Promise<{
            status: number;
            location: string | undefined;
            contentType: string | undefined;
            cacheControl: string | undefined;
            body: string;
          }>((resolve, reject) => {
            const req = httpRequest({ host: "127.0.0.1", port: ctx.port, method, path }, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  location: res.headers.location,
                  contentType: Array.isArray(res.headers["content-type"])
                    ? res.headers["content-type"][0]
                    : res.headers["content-type"],
                  cacheControl: Array.isArray(res.headers["cache-control"])
                    ? res.headers["cache-control"][0]
                    : res.headers["cache-control"],
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            });
            req.on("error", reject);
            req.end();
          });
          expect(status, `${method} ${path}`).toBe(404);
          expect(location).toBeUndefined();
          expect(contentType).toMatch(/text\/html/);
          expect(cacheControl).toBe("no-store");
          if (method === "HEAD") {
            expect(body).toBe("");
          } else {
            expect(body).toContain("Not found.");
            expect(body).toContain("sg02");
            expect(body).not.toMatch(/data-once-bearer=/);
          }
        }
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue/?foo=1 and /console/revoke/?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue/?foo=1", "/console/revoke/?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "OPTIONS" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/issue?foo=1 and /console/revoke?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?foo=1", "/console/revoke?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const { status, location, contentType, cacheControl, body } = await new Promise<{
          status: number;
          location: string | undefined;
          contentType: string | undefined;
          cacheControl: string | undefined;
          body: string;
        }>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: ctx.port, method: "TRACE", path },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  location: res.headers.location,
                  contentType: Array.isArray(res.headers["content-type"])
                    ? res.headers["content-type"][0]
                    : res.headers["content-type"],
                  cacheControl: Array.isArray(res.headers["cache-control"])
                    ? res.headers["cache-control"][0]
                    : res.headers["cache-control"],
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status).toBe(404);
        expect(location).toBeUndefined();
        expect(contentType).toMatch(/text\/html/);
        expect(cacheControl).toBe("no-store");
        expect(body).toContain("Not found.");
        expect(body).toContain("sg02");
        expect(body).not.toMatch(/data-once-bearer=/);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/issue?foo=1 and /console/revoke?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?foo=1", "/console/revoke?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const { status, location, contentType, cacheControl, body } = await new Promise<{
          status: number;
          location: string | undefined;
          contentType: string | undefined;
          cacheControl: string | undefined;
          body: string;
        }>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: ctx.port, method: "HEAD", path },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  location: res.headers.location,
                  contentType: Array.isArray(res.headers["content-type"])
                    ? res.headers["content-type"][0]
                    : res.headers["content-type"],
                  cacheControl: Array.isArray(res.headers["cache-control"])
                    ? res.headers["cache-control"][0]
                    : res.headers["cache-control"],
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status).toBe(404);
        expect(location).toBeUndefined();
        expect(contentType).toMatch(/text\/html/);
        expect(cacheControl).toBe("no-store");
        expect(body).toBe("");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/issue?foo=1 and /console/revoke?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?foo=1", "/console/revoke?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "PUT" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/issue?foo=1 and /console/revoke?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?foo=1", "/console/revoke?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "PATCH" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/issue?foo=1 and /console/revoke?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue?foo=1", "/console/revoke?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method: "DELETE" });
        expect(res.status).toBe(404);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toMatch(/text\/html/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const html = await res.text();
        expect(html).toContain("Not found.");
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/issue/?foo=1 and /console/revoke/?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue/?foo=1", "/console/revoke/?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const { status, location, contentType, cacheControl, body } = await new Promise<{
          status: number;
          location: string | undefined;
          contentType: string | undefined;
          cacheControl: string | undefined;
          body: string;
        }>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: ctx.port, method: "TRACE", path },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  location: res.headers.location,
                  contentType: Array.isArray(res.headers["content-type"])
                    ? res.headers["content-type"][0]
                    : res.headers["content-type"],
                  cacheControl: Array.isArray(res.headers["cache-control"])
                    ? res.headers["cache-control"][0]
                    : res.headers["cache-control"],
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status).toBe(404);
        expect(location).toBeUndefined();
        expect(contentType).toMatch(/text\/html/);
        expect(cacheControl).toBe("no-store");
        expect(body).toContain("Not found.");
        expect(body).toContain("sg02");
        expect(body).not.toMatch(/data-once-bearer=/);
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/issue/?foo=1 and /console/revoke/?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue/?foo=1", "/console/revoke/?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const { status, location, contentType, cacheControl, body } = await new Promise<{
          status: number;
          location: string | undefined;
          contentType: string | undefined;
          cacheControl: string | undefined;
          body: string;
        }>((resolve, reject) => {
          const req = httpRequest(
            { host: "127.0.0.1", port: ctx.port, method: "HEAD", path },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  location: res.headers.location,
                  contentType: Array.isArray(res.headers["content-type"])
                    ? res.headers["content-type"][0]
                    : res.headers["content-type"],
                  cacheControl: Array.isArray(res.headers["cache-control"])
                    ? res.headers["cache-control"][0]
                    : res.headers["cache-control"],
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(status).toBe(404);
        expect(location).toBeUndefined();
        expect(contentType).toMatch(/text\/html/);
        expect(cacheControl).toBe("no-store");
        expect(body).toBe("");
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT PATCH DELETE /console/issue/?foo=1 and /console/revoke/?foo=1 instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const path of ["/console/issue/?foo=1", "/console/revoke/?foo=1"]) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");
        for (const method of ["PUT", "PATCH", "DELETE"] as const) {
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { method });
          expect(res.status).toBe(404);
          expect(res.headers.get("location")).toBeNull();
          expect(res.headers.get("content-type")).toMatch(/text\/html/);
          expect(res.headers.get("cache-control")).toBe("no-store");
          const html = await res.text();
          expect(html).toContain("Not found.");
          expect(html).toContain("sg02");
          expect(html).not.toContain(keepRaw);
        }
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 204 for favicon so the console page has no 404", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/favicon.ico`);
      expect(res.status).toBe(204);
    } finally {
      await ctx.close();
    }
  });

  it("shows empty audit copy when the log is missing rows", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const html = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(html).toContain("No audit rows in this window.");
      expect(html).toContain("No host-id bearers");
      expect(html).toContain("No hosts have presented a writer identity yet.");
      expect(html).toContain("0 issued");
      expect(html).not.toContain("Monthly quota");
      expect(html).not.toContain("Model calls");
      expect(html).not.toContain("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("renders keys, devices, and usage from token-map and audit fields only", async () => {
    const hash = hashToken("console-keys-token");
    const lines = [
      JSON.stringify({
        ts: "2026-09-14T00:00:01.000Z",
        host_id: "macos-dev",
        tool: "wiki_status",
        ok: true,
        ms: 4,
      }),
      JSON.stringify({
        ts: "2026-09-14T00:00:10.000Z",
        host_id: "macos-dev",
        tool: "wiki_query",
        path: "concepts/alpha.md",
        ok: true,
        ms: 12,
      }),
      JSON.stringify({
        ts: "2026-09-14T00:00:05.000Z",
        host_id: "chatgpt-web",
        tool: "wiki_context",
        ok: false,
        error: "TOOLS_NOT_READY",
        ms: 9,
      }),
    ];
    const ctx = await startConsole({ tokenMapYaml: `${hash}: macos-dev\n`, auditLines: lines });
    try {
      const html = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();

      expect(html).toContain("Host-id bearers");
      expect(html).toContain("1 issued");
      expect(html).toContain("<th>Host-id</th><th>Fingerprint</th><th>Status</th><th>Actions</th>");
      expect(html).toContain("macos-dev");
      expect(html).toContain(`••••${hash.slice(-4)}`);
      expect(html).toContain("Enabled");
      expect(html).toContain('aria-label="Revoke macos-dev"');
      expect(html).not.toContain("console-keys-token");
      expect(html).not.toContain("Disabled");

      expect(html).toContain("Fleet hosts");
      expect(html).toContain("<th>Host-id</th><th>First seen</th><th>Last active</th><th>Actions</th>");
      expect(html).toContain('datetime="2026-09-14T00:00:01.000Z"');
      expect(html).toContain('datetime="2026-09-14T00:00:10.000Z"');
      expect(html).toContain("chatgpt-web");
      expect(html).toContain("Unmapped");
      expect(html).not.toContain('aria-label="Revoke chatgpt-web"');
      expect(html).not.toMatch(/Revoke chatgpt-web/);

      expect(html).toContain("MCP audit");
      expect(html).toContain("<th>When</th><th>Tool</th><th>Writer</th><th>Path</th><th>Result</th><th>Latency</th>");
      expect(html).toContain("wiki_query");
      expect(html).toContain("concepts/alpha.md");
      expect(html).toContain("12 ms");
      expect(html).toContain("TOOLS_NOT_READY");
      expect(html).toContain("3 records");
      expect(html).not.toContain("Monthly quota");
      expect(html).not.toContain("Model calls");
    } finally {
      await ctx.close();
    }
  });

  it("shows fleet-sized issued count for two keys and refuses revoke of an unknown host-id", async () => {
    const a = hashToken("token-a");
    const b = hashToken("token-b");
    const ctx = await startConsole({ tokenMapYaml: `${a}: macos-dev\n${b}: sg02\n` });
    try {
      const html = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(html).toContain("2 issued");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("No hosts have presented a writer identity yet.");
      expect(html).not.toContain("token-a");
      expect(html).not.toContain("token-b");

      const missing = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03&confirm=1",
      });
      expect(missing.status).toBe(400);
      const denied = await missing.text();
      expect(denied).toContain("Host-id not found.");
      expect(denied).toContain("2 issued");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  it("revokes one mapped host-id and leaves the other key usable", async () => {
    const keepRaw = "keep-mapped-token";
    const dropRaw = "drop-mapped-token";
    const keepHash = hashToken(keepRaw);
    const dropHash = hashToken(dropRaw);
    const lines = [
      JSON.stringify({
        ts: "2026-09-14T00:00:01.000Z",
        host_id: "macos-dev",
        tool: "wiki_status",
        ok: true,
        ms: 4,
      }),
      JSON.stringify({
        ts: "2026-09-14T00:00:02.000Z",
        host_id: "sg02",
        tool: "wiki_query",
        ok: true,
        ms: 8,
      }),
    ];
    const ctx = await startConsole({
      tokenMapYaml: `${keepHash}: sg02\n${dropHash}: macos-dev\n`,
      auditLines: lines,
    });

    async function callContext(token: string) {
      return fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
    }

    try {
      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(revoked.status).toBe(200);
      const html = await revoked.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).toContain(`••••${keepHash.slice(-4)}`);
      expect(html).not.toContain(`••••${dropHash.slice(-4)}`);
      expect(html).not.toContain('aria-label="Revoke macos-dev"');
      expect(html).toContain('aria-label="Revoke sg02"');
      expect(html).toContain("macos-dev");
      expect(html).toContain("Unmapped");
      expect(html).not.toContain(keepRaw);
      expect(html).not.toContain(dropRaw);
      expect(html).not.toContain("chatgpt-web");

      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect([...map.values()]).toEqual(["sg02"]);
      expect(map.has(keepHash)).toBe(true);
      expect(map.has(dropHash)).toBe(false);

      const kept = await callContext(keepRaw);
      expect(kept.status).toBe(200);
      const keptBody = (await kept.json()) as {
        result?: { structuredContent?: { ok?: boolean; writer_id?: string } };
      };
      expect(keptBody.result?.structuredContent?.ok).toBe(true);
      expect(keptBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(keptBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const dropped = await callContext(dropRaw);
      expect(dropped.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it("can re-issue a host-id after that mapped key was revoked", async () => {
    const oldRaw = "old-macos-token";
    const hash = hashToken(oldRaw);
    const ctx = await startConsole({ tokenMapYaml: `${hash}: macos-dev\n` });

    async function callContext(token: string) {
      return fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
    }

    try {
      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(revoked.status).toBe(200);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(0);

      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(issued.status).toBe(200);
      const html = await issued.text();
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(raw).not.toBe(oldRaw);
      expect(html).toContain("1 issued");
      expect(html).toContain("macos-dev");
      expect(html).not.toContain(oldRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      const newHash = [...map.keys()][0]!;
      expect([...map.values()]).toEqual(["macos-dev"]);
      expect(map.has(hash)).toBe(false);
      expect(newHash).not.toBe(hash);
      expect(newHash).toBe(hashToken(raw!));
      expect(html).toContain(`••••${newHash.slice(-4)}`);

      const oldDenied = await callContext(oldRaw);
      expect(oldDenied.status).toBe(401);
      const ok = await callContext(raw!);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        result?: { structuredContent?: { ok?: boolean; writer_id?: string } };
      };
      expect(body.result?.structuredContent?.ok).toBe(true);
      expect(body.result?.structuredContent?.writer_id).toBe("macos-dev");
      expect(body.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("re-issues a revoked host-id without dropping a sibling key", async () => {
    const keepRaw = "keep-sg02-token";
    const oldRaw = "old-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(oldRaw)}: macos-dev\n`,
    });
    try {
      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(revoked.status).toBe(200);
      expect([...parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values()]).toEqual(["sg02"]);

      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(issued.status).toBe(200);
      const html = await issued.text();
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(raw).not.toBe(oldRaw);
      expect(raw).not.toBe(keepRaw);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg02");
      expect(html).toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(new Set(map.values())).toEqual(new Set(["sg02", "macos-dev"]));
      expect(map.has(hashToken(keepRaw))).toBe(true);
      expect(map.has(hashToken(oldRaw))).toBe(false);

      const kept = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(kept.status).toBe(200);
      const keptBody = (await kept.json()) as {
        result?: { structuredContent?: { ok?: boolean; writer_id?: string } };
      };
      expect(keptBody.result?.structuredContent?.ok).toBe(true);
      expect(keptBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(keptBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const oldDenied = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oldRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(oldDenied.status).toBe(401);

      const reissued = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(reissued.status).toBe(200);
      const reissuedBody = (await reissued.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(reissuedBody.result?.structuredContent?.writer_id).toBe("macos-dev");
      expect(reissuedBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const reload = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(reload).toContain("2 issued");
      expect(reload).toContain('aria-label="Revoke sg02"');
      expect(reload).toContain('aria-label="Revoke macos-dev"');
      expect(reload).not.toContain(keepRaw);
      expect(reload).not.toContain(oldRaw);
      expect(reload).not.toMatch(/data-once-bearer=/);
    } finally {
      await ctx.close();
    }
  });

  it("refuses a duplicate host-id with operator copy and no once-bearer", async () => {
    const existing = hashToken("seed-token");
    const ctx = await startConsole({ tokenMapYaml: `${existing}: macos-dev\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("That host-id is already issued.");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("refuses a colliding hash with retry copy and leaves the sibling key", async () => {
    const colliding = tokenMapMod.generateHostBearer(() => Buffer.alloc(32, 9));
    const siblingRaw = "keep-sg02-token";
    const ctx = await startConsole({
      tokenMapYaml: `${colliding.hashHex}: macos-dev\n${hashToken(siblingRaw)}: sg02\n`,
    });
    const spy = vi.spyOn(tokenMapMod, "generateHostBearer").mockReturnValue(colliding);
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Could not issue. Retry.");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(colliding.raw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.size).toBe(2);
      expect(map.get(colliding.hashHex)).toBe("macos-dev");
      expect(map.get(hashToken(siblingRaw))).toBe("sg02");
      expect(new Set(map.values())).toEqual(new Set(["macos-dev", "sg02"]));

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${siblingRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      spy.mockRestore();
      await ctx.close();
    }
  });

  it("marks unmapped audit writers and escapes XSS in audit fields", async () => {
    const lines = [
      JSON.stringify({
        ts: "2026-09-14T00:00:01.000Z",
        host_id: "chatgpt-web",
        tool: "<script>alert(1)</script>",
        path: "<img src=x onerror=alert(1)>",
        ok: false,
        error: "<b>boom</b>",
        ms: 9,
      }),
    ];
    const ctx = await startConsole({ tokenMapYaml: `${hashToken("t")}: macos-dev\n`, auditLines: lines });
    try {
      const html = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(html).toContain("chatgpt-web");
      expect(html).toContain("Unmapped");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;");
      expect(html).not.toContain("<script>alert(1)</script>");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for unknown /console routes and no-store on GET /console", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const missing = await fetch(`http://127.0.0.1:${ctx.port}/console/not-a-route`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toMatch(/text\/html/);
      expect(await missing.text()).toContain("Not found.");

      const posted = await fetch(`http://127.0.0.1:${ctx.port}/console/not-a-route`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(posted.status).toBe(404);
      expect(posted.headers.get("content-type")).toMatch(/text\/html/);
      const postedHtml = await posted.text();
      expect(postedHtml).toContain("Not found.");
      expect(postedHtml).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).size).toBe(0);

      for (const method of ["PUT", "DELETE"] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`, { method });
        expect(res.status, method).toBe(404);
        expect(res.headers.get("content-type"), method).toMatch(/text\/html/);
        const html = await res.text();
        expect(html, method).toContain("Not found.");
        expect(html, method).not.toMatch(/data-once-bearer=/);
      }

      const page = await fetch(`http://127.0.0.1:${ctx.port}/console`);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const html = await page.text();
      expect(html).toContain('<h1 class="visually-hidden">SkillWiki console</h1>');
      expect(html).toContain("code.clip");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console`, { method: "PATCH" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/ on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/ on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/ on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for HEAD /console on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, headers, body } = await new Promise<{
        status: number;
        headers: Record<string, string | string[] | undefined>;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(String(headers["content-type"])).toMatch(/text\/html/);
      expect(headers["cache-control"]).toBe("no-store");
      expect(body).toBe("");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for HEAD /console// instead of the GET 200", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const getSlash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(getSlash.status).toBe(200);

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for HEAD /console/ instead of the GET 200", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const getSlash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(getSlash.status).toBe(200);

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for HEAD /console/// instead of the GET 200", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const getSlash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(getSlash.status).toBe(200);

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "OPTIONS", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/ on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "OPTIONS", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/issue instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const { status, location, contentType, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/issue" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/issue/ instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/issue/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/revoke instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const redirected = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { redirect: "manual" });
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get("location")).toBe("/console");

      const { status, location, contentType, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/revoke" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(body).toBe("");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/revoke/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/revoke/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/issue// instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/revoke// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/issue/// instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
    } finally {
      await ctx.close();
    }
  });

  it("returns 404 for HEAD /console/revoke/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "HEAD", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toBe("");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { method: "OPTIONS" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "OPTIONS", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "OPTIONS", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/issue/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "OPTIONS", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for OPTIONS /console/revoke/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "OPTIONS", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/issue instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/issue" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/revoke instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/revoke" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/issue/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/issue/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/revoke/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/revoke/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/issue// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/revoke// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/issue/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/revoke/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/issue instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { method: "PUT" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/revoke instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { method: "PUT" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/issue/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { method: "PUT" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/revoke/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { method: "PUT" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/issue// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/revoke// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/issue/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PUT /console/revoke/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PUT", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/issue instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { method: "PATCH" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/revoke instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { method: "PATCH" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/issue/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { method: "PATCH" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/revoke/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { method: "PATCH" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/issue// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/revoke// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/issue/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for PATCH /console/revoke/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "PATCH", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/issue instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/revoke instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/issue/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/revoke/ instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/issue// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/revoke// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/issue/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for DELETE /console/revoke/// instead of the GET 302", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const { status, location, contentType, cacheControl, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "DELETE", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(body).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/ on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console/" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for TRACE /console/// on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "TRACE", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console on the bare path", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03&confirm=1",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");

      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(issued.status).toBe(200);
      const issuedHtml = await issued.text();
      expect(issuedHtml).toMatch(/data-once-bearer=/);
      expect(issuedHtml).toContain("2 issued");
      expect(new Set(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values())).toEqual(
        new Set(["sg02", "sg03"]),
      );
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console/ trailing slash on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const getSlash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(getSlash.status).toBe(200);
      expect(await getSlash.text()).toContain("Host-id bearers");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03&confirm=1",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("Not found.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain(keepRaw);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console/// triple slash on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const bodyText = "host_id=sg03&confirm=1";
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console///",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console// double slash on loopback", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const bodyText = "host_id=sg03&confirm=1";
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console//",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/ trailing slash", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("1 issued");
      expect(html).toContain("sg03");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect([...parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values()]).toEqual(["sg03"]);

      const redirected = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get("location")).toBe("/console");

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg03");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const reload = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(reload).not.toMatch(/data-once-bearer=/);
      expect(reload).not.toContain(raw);
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?page=0", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?page=0`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?page=0`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg03");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg03"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg03");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with page and foo queries", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const [path, hostId] of [
        ["/console/issue/?page=0", "sg04"],
        ["/console/issue?page=1", "sg05"],
        ["/console/issue?foo=1", "sg06"],
        ["/console/issue?page=-1", "sg07"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${hostId}`,
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/data-once-bearer=/);
        expect(html).toContain(hostId);
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
        expect([...parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values()]).toContain(hostId);
      }
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?bar=2", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?bar=2`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?bar=2`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg08",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg08");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg08"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg08");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with combined and clamp queries", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const [path, hostId] of [
        ["/console/issue?foo=1&bar=2", "sg09"],
        ["/console/issue?page=999", "sg10"],
        ["/console/issue?page=foo", "sg11"],
        ["/console/issue?page=1.5", "sg12"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${hostId}`,
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/data-once-bearer=/);
        expect(html).toContain(hostId);
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
        expect([...parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values()]).toContain(hostId);
      }
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?foo=1", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?foo=1`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?foo=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg13",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg13");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg13"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg13");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?page=2", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?page=2`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?page=2`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg18",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg18");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg18"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg18");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/ with slash-query leftovers", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const [path, hostId] of [
        ["/console/issue/?bar=2", "sg14"],
        ["/console/issue/?page=1", "sg15"],
        ["/console/issue/?page=2", "sg16"],
        ["/console/issue/?foo=1&bar=2", "sg17"],
        ["/console/issue/?page=-1", "sg19"],
        ["/console/issue/?page=999", "sg20"],
        ["/console/issue/?page=foo", "sg21"],
        ["/console/issue/?page=1.5", "sg22"],
        ["/console/issue?foo=1&page=0", "sg23"],
        ["/console/issue?page=0&foo=1", "sg24"],
        ["/console/issue?confirm=1", "sg25"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${hostId}`,
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/data-once-bearer=/);
        expect(html).toContain(hostId);
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
        expect([...parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values()]).toContain(hostId);
      }
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?page=0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?page=0`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?page=0`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?foo=1", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?foo=1`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?foo=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?page=2", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?page=2`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?page=2`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=1 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=1 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke when host_id and confirm are only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue/?host_id=sg99 when host_id is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("issues the body host-id on POST /console/issue/?host_id=sg99", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?host_id=sg99`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg26",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg26");
      expect(html).toContain("sg02");
      expect(html).not.toContain("sg99");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg26"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg26");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?host_id=sg99 when host_id is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=1 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=1 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?host_id=macos-dev&confirm=1 when fields are only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke/?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes the body host-id on POST /console/revoke?host_id=sg02&confirm=1", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?host_id=sg02&confirm=1`, {
        redirect: "manual",
      });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?host_id=sg02&confirm=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes the body host-id on POST /console/revoke/?host_id=sg02&confirm=1", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?host_id=sg02&confirm=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?host_id=macos-dev&confirm=1 when host_id is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke/?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "confirm=1",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?host_id=macos-dev&confirm=1 when host_id is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "confirm=1",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue/?host_id=sg99 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?host_id=sg99 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?host_id=sg99 when body host_id is %20", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=%20",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?host_id=sg99 when body host_id is +", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=+",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?host_id=sg99 when body host_id is %09", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=%09",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?host_id=macos-dev&confirm=1 when body host_id is %20", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        { redirect: "manual" },
      );
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=%20&confirm=1",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?host_id=macos-dev&confirm=1 when body host_id is +", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        { redirect: "manual" },
      );
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=+&confirm=1",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=+ with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=+`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=+`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%20 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%20`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%20`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%31 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%31`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%31`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%31 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%31`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%31`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%32 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%32`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%32`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%32 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%32`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%32`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%32 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%32`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%32 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%32`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%30 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%30`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%30`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%30 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%30`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%30`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%30 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%30`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%30 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%30`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%33 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%33`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%33`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%33 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%33`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%33`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%33 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%33`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%33 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%33`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%34 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%34`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%34`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%34 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%34`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%34`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%34 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%34`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%34 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%34`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%35 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%35`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%35`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%35 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%35`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%35`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%35 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%35`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%35 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%35`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?confirm=%36 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%36`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%36`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?confirm=%36 when confirm is only in the query", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%36`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%36`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke?confirm=%36 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%36`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%36 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%36`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke with remaining encoded confirm queries when confirm is only in the query", async () => {
    const queries = [
      "?confirm=%37",
      "/?confirm=%37",
      "?confirm=%38",
      "/?confirm=%38",
      "?confirm=%39",
      "/?confirm=%39",
      "?confirm=%2b",
      "/?confirm=%2b",
      "?confirm=%37&page=0",
      "/?confirm=%37&foo=1",
      "?confirm=%25",
      "/?confirm=%25",
      "?confirm=%41",
      "/?confirm=%41",
      "?confirm=%61",
      "/?confirm=%61",
      "?confirm=%3d",
      "/?confirm=%3d",
      "?confirm=%26",
      "/?confirm=%26",
      "?confirm=%7e",
      "/?confirm=%7e",
      "?confirm=%2f",
      "/?confirm=%2f",
      "?confirm=%2a",
      "/?confirm=%2a",
      "?confirm=%23",
      "/?confirm=%23",
      "?confirm=%40",
      "/?confirm=%40",
      "?confirm=%5b",
      "/?confirm=%5b",
      "?confirm=%5d",
      "/?confirm=%5d",
      "?confirm=%7c",
      "/?confirm=%7c",
      "?confirm=%3f",
      "/?confirm=%3f",
      "?page=0&confirm=%37",
      "?foo=1&confirm=%37",
      "?page=2&confirm=%37",
      "/?page=0&confirm=%37",
      "?bar=2&confirm=%37",
      "/?bar=2&confirm=%37",
      "?baz=3&confirm=%37",
      "/?baz=3&confirm=%37",
      "?qux=4&confirm=%37",
      "/?qux=4&confirm=%37",
      "?quux=5&confirm=%37",
      "/?quux=5&confirm=%37",
      "?corge=6&confirm=%37",
      "/?corge=6&confirm=%37",
      "?grault=7&confirm=%37",
      "/?grault=7&confirm=%37",
      "?garply=8&confirm=%37",
      "/?garply=8&confirm=%37",
      "?waldo=9&confirm=%37",
      "/?waldo=9&confirm=%37",
      "?fred=10&confirm=%37",
      "/?fred=10&confirm=%37",
      "?plugh=11&confirm=%37",
      "/?plugh=11&confirm=%37",
      "?xyzzy=12&confirm=%37",
      "/?xyzzy=12&confirm=%37",
      "?thud=13&confirm=%37",
      "/?thud=13&confirm=%37",
      "?spam=1&confirm=%37",
      "/?spam=1&confirm=%37",
      "?eggs=2&confirm=%37",
      "/?eggs=2&confirm=%37",
      "?ham=3&confirm=%37",
      "/?ham=3&confirm=%37",
      "?confirm=%37&qux=4",
      "/?confirm=%37&qux=4",
      "?qux=4&page=0&confirm=%37",
      "?qux=4&foo=1&confirm=%37",
      "?foo=1&bar=2&confirm=%37",
      "/?foo=1&bar=2&confirm=%37",
      "?foo=1&bar=2&baz=3&confirm=%37",
      "?foo=1&bar=2&baz=3&qux=4&confirm=%37",
      "?confirm=%37&foo=1&bar=2",
      "?a=1&b=2&c=3&d=4&e=5&confirm=%37",
      "?qux=4&confirm=%38",
      "/?qux=4&confirm=%38",
      "?ha=1&confirm=%38",
      "/?ha=1&confirm=%38",
      "?qux=4&confirm=%39",
      "/?qux=4&confirm=%39",
      "?ha=1&confirm=%39",
      "/?ha=1&confirm=%39",
      "?ha=1&confirm=%3a",
      "/?ha=1&confirm=%3a",
      "?ha=1&confirm=%3b",
      "/?ha=1&confirm=%3b",
      "?ha=1&confirm=%3c",
      "/?ha=1&confirm=%3c",
      "?ha=1&confirm=%3d",
      "/?ha=1&confirm=%3d",
      "?ha=1&confirm=%3e",
      "/?ha=1&confirm=%3e",
      "?ha=1&confirm=%3f",
      "/?ha=1&confirm=%3f",
      "?ha=1&confirm=%40",
      "/?ha=1&confirm=%40",
      "?ha=1&confirm=%41",
      "/?ha=1&confirm=%41",
      "?ha=1&confirm=%42",
      "/?ha=1&confirm=%42",
      "?ha=1&confirm=%43",
      "/?ha=1&confirm=%43",
      "?ha=1&confirm=%44",
      "/?ha=1&confirm=%44",
      "?ha=1&confirm=%45",
      "/?ha=1&confirm=%45",
      "?ha=1&confirm=%46",
      "/?ha=1&confirm=%46",
      "?ha=1&confirm=%47",
      "/?ha=1&confirm=%47",
      "?ha=1&confirm=%48",
      "/?ha=1&confirm=%48",
      "?ha=1&confirm=%49",
      "/?ha=1&confirm=%49",
      "?ha=1&confirm=%4a",
      "/?ha=1&confirm=%4a",
      "?ha=1&confirm=%4b",
      "/?ha=1&confirm=%4b",
      "?ha=1&confirm=%4c",
      "/?ha=1&confirm=%4c",
      "?ha=1&confirm=%4d",
      "/?ha=1&confirm=%4d",
      "?ha=1&confirm=%4e",
      "/?ha=1&confirm=%4e",
      "?ha=1&confirm=%4f",
      "/?ha=1&confirm=%4f",
      "?ha=1&confirm=%50",
      "/?ha=1&confirm=%50",
      "?ha=1&confirm=%51",
      "/?ha=1&confirm=%51",
      "?ha=1&confirm=%52",
      "/?ha=1&confirm=%52",
      "?ha=1&confirm=%53",
      "/?ha=1&confirm=%53",
      "?ha=1&confirm=%54",
      "/?ha=1&confirm=%54",
      "?ha=1&confirm=%55",
      "/?ha=1&confirm=%55",
      "?ha=1&confirm=%56",
      "/?ha=1&confirm=%56",
      "?ha=1&confirm=%57",
      "/?ha=1&confirm=%57",
      "?ha=1&confirm=%58",
      "/?ha=1&confirm=%58",
      "?ha=1&confirm=%59",
      "/?ha=1&confirm=%59",
      "?ha=1&confirm=%5a",
      "/?ha=1&confirm=%5a",
      "?ha=1&confirm=%5b",
      "/?ha=1&confirm=%5b",
      "?ha=1&confirm=%5c",
      "/?ha=1&confirm=%5c",
      "?ha=1&confirm=%5d",
      "/?ha=1&confirm=%5d",
      "?ha=1&confirm=%5e",
      "/?ha=1&confirm=%5e",
      "?ha=1&confirm=%5f",
      "/?ha=1&confirm=%5f",
      "?ha=1&confirm=%60",
      "/?ha=1&confirm=%60",
      "?ha=1&confirm=%61",
      "/?ha=1&confirm=%61",
      "?ha=1&confirm=%62",
      "/?ha=1&confirm=%62",
      "?ha=1&confirm=%63",
      "/?ha=1&confirm=%63",
      "?ha=1&confirm=%64",
      "/?ha=1&confirm=%64",
      "?ha=1&confirm=%65",
      "/?ha=1&confirm=%65",
      "?ha=1&confirm=%66",
      "/?ha=1&confirm=%66",
      "?ha=1&confirm=%67",
      "/?ha=1&confirm=%67",
      "?ha=1&confirm=%68",
      "/?ha=1&confirm=%68",
      "?ha=1&confirm=%69",
      "/?ha=1&confirm=%69",
      "?ha=1&confirm=%6a",
      "/?ha=1&confirm=%6a",
      "?ha=1&confirm=%6b",
      "/?ha=1&confirm=%6b",
      "?ha=1&confirm=%6c",
      "/?ha=1&confirm=%6c",
      "?ha=1&confirm=%6d",
      "/?ha=1&confirm=%6d",
      "?ha=1&confirm=%6e",
      "/?ha=1&confirm=%6e",
      "?ha=1&confirm=%6f",
      "/?ha=1&confirm=%6f",
      "?ha=1&confirm=%70",
      "/?ha=1&confirm=%70",
      "?ha=1&confirm=%71",
      "/?ha=1&confirm=%71",
      "?ha=1&confirm=%72",
      "/?ha=1&confirm=%72",
      "?ha=1&confirm=%73",
      "/?ha=1&confirm=%73",
      "?ha=1&confirm=%74",
      "/?ha=1&confirm=%74",
      "?ha=1&confirm=%75",
      "/?ha=1&confirm=%75",
      "?ha=1&confirm=%76",
      "/?ha=1&confirm=%76",
      "?ha=1&confirm=%77",
      "/?ha=1&confirm=%77",
      "?ha=1&confirm=%78",
      "/?ha=1&confirm=%78",
      "?ha=1&confirm=%79",
      "/?ha=1&confirm=%79",
      "?ha=1&confirm=%7a",
      "/?ha=1&confirm=%7a",
      "?ha=1&confirm=%7b",
      "/?ha=1&confirm=%7b",
      "?ha=1&confirm=%7c",
      "/?ha=1&confirm=%7c",
      "?ha=1&confirm=%7d",
      "/?ha=1&confirm=%7d",
      "?ha=1&confirm=%7e",
      "/?ha=1&confirm=%7e",
      "?ha=1&confirm=%7f",
      "/?ha=1&confirm=%7f",
      "?ha=1&confirm=%80",
      "/?ha=1&confirm=%80",
      "?ha=1&confirm=%81",
      "/?ha=1&confirm=%81",
      "?ha=1&confirm=%82",
      "/?ha=1&confirm=%82",
      "?ha=1&confirm=%83",
      "/?ha=1&confirm=%83",
      "?ha=1&confirm=%84",
      "/?ha=1&confirm=%84",
      "?ha=1&confirm=%85",
      "/?ha=1&confirm=%85",
      "?ha=1&confirm=%86",
      "/?ha=1&confirm=%86",
      "?ha=1&confirm=%87",
      "/?ha=1&confirm=%87",
      "?ha=1&confirm=%88",
      "/?ha=1&confirm=%88",
      "?ha=1&confirm=%89",
      "/?ha=1&confirm=%89",
      "?ha=1&confirm=%8a",
      "/?ha=1&confirm=%8a",
      "?ha=1&confirm=%8b",
      "/?ha=1&confirm=%8b",
      "?ha=1&confirm=%8c",
      "/?ha=1&confirm=%8c",
      "?ha=1&confirm=%8d",
      "/?ha=1&confirm=%8d",
      "?ha=1&confirm=%8e",
      "/?ha=1&confirm=%8e",
      "?ha=1&confirm=%8f",
      "/?ha=1&confirm=%8f",
      "?n=1&confirm=%37",
      "/?n=1&confirm=%37",
      "?m=2&confirm=%37",
      "/?m=2&confirm=%37",
      "?p=3&confirm=%37",
      "/?p=3&confirm=%37",
      "?q=1&confirm=%37",
      "/?q=1&confirm=%37",
      "?r=1&confirm=%37",
      "/?r=1&confirm=%37",
      "?s=1&confirm=%37",
      "/?s=1&confirm=%37",
      "?t=1&confirm=%37",
      "/?t=1&confirm=%37",
    ] as const;
    for (const query of queries) {
      const keepRaw = "keep-sg02-token";
      const dropRaw = "drop-macos-token";
      const ctx = await startConsole({
        tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
      });
      try {
        const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, { redirect: "manual" });
        expect(get.status, query).toBe(302);
        expect(get.headers.get("location"), query).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=macos-dev",
        });
        expect(res.status, query).toBe(400);
        const html = await res.text();
        expect(html, query).toContain("Revoke requires confirmation.");
        expect(html).toContain("macos-dev");
        expect(html).toContain("sg02");
        expect(html).toContain("2 issued");
        const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
        expect(map.get(hashToken(keepRaw))).toBe("sg02");
        expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
      } finally {
        await ctx.close();
      }
    }
  }, 120_000);

  it("revokes a host-id on POST /console/revoke with remaining encoded confirm queries and a valid body", async () => {
    const queries = [
      "?confirm=%37",
      "/?confirm=%37",
      "?confirm=%38",
      "/?confirm=%38",
      "?confirm=%39",
      "/?confirm=%39",
      "?confirm=%2b",
      "/?confirm=%2b",
      "?confirm=%37&page=0",
      "/?confirm=%37&foo=1",
      "?confirm=%25",
      "/?confirm=%25",
      "?confirm=%41",
      "/?confirm=%41",
      "?confirm=%61",
      "/?confirm=%61",
      "?confirm=%3d",
      "/?confirm=%3d",
      "?confirm=%26",
      "/?confirm=%26",
      "?confirm=%7e",
      "/?confirm=%7e",
      "?confirm=%2f",
      "/?confirm=%2f",
      "?confirm=%2a",
      "/?confirm=%2a",
      "?confirm=%23",
      "/?confirm=%23",
      "?confirm=%40",
      "/?confirm=%40",
      "?confirm=%5b",
      "/?confirm=%5b",
      "?confirm=%5d",
      "/?confirm=%5d",
      "?confirm=%7c",
      "/?confirm=%7c",
      "?confirm=%3f",
      "/?confirm=%3f",
      "?page=0&confirm=%37",
      "?foo=1&confirm=%37",
      "?page=2&confirm=%37",
      "/?page=0&confirm=%37",
      "?bar=2&confirm=%37",
      "/?bar=2&confirm=%37",
      "?baz=3&confirm=%37",
      "/?baz=3&confirm=%37",
      "?qux=4&confirm=%37",
      "/?qux=4&confirm=%37",
      "?quux=5&confirm=%37",
      "/?quux=5&confirm=%37",
      "?corge=6&confirm=%37",
      "/?corge=6&confirm=%37",
      "?grault=7&confirm=%37",
      "/?grault=7&confirm=%37",
      "?garply=8&confirm=%37",
      "/?garply=8&confirm=%37",
      "?waldo=9&confirm=%37",
      "/?waldo=9&confirm=%37",
      "?fred=10&confirm=%37",
      "/?fred=10&confirm=%37",
      "?plugh=11&confirm=%37",
      "/?plugh=11&confirm=%37",
      "?xyzzy=12&confirm=%37",
      "/?xyzzy=12&confirm=%37",
      "?thud=13&confirm=%37",
      "/?thud=13&confirm=%37",
      "?spam=1&confirm=%37",
      "/?spam=1&confirm=%37",
      "?eggs=2&confirm=%37",
      "/?eggs=2&confirm=%37",
      "?ham=3&confirm=%37",
      "/?ham=3&confirm=%37",
      "?confirm=%37&qux=4",
      "/?confirm=%37&qux=4",
      "?qux=4&page=0&confirm=%37",
      "?qux=4&foo=1&confirm=%37",
      "?foo=1&bar=2&confirm=%37",
      "/?foo=1&bar=2&confirm=%37",
      "?foo=1&bar=2&baz=3&confirm=%37",
      "?foo=1&bar=2&baz=3&qux=4&confirm=%37",
      "?confirm=%37&foo=1&bar=2",
      "?a=1&b=2&c=3&d=4&e=5&confirm=%37",
      "?qux=4&confirm=%38",
      "/?qux=4&confirm=%38",
      "?ha=1&confirm=%38",
      "/?ha=1&confirm=%38",
      "?qux=4&confirm=%39",
      "/?qux=4&confirm=%39",
      "?ha=1&confirm=%39",
      "/?ha=1&confirm=%39",
      "?ha=1&confirm=%3a",
      "/?ha=1&confirm=%3a",
      "?ha=1&confirm=%3b",
      "/?ha=1&confirm=%3b",
      "?ha=1&confirm=%3c",
      "/?ha=1&confirm=%3c",
      "?ha=1&confirm=%3d",
      "/?ha=1&confirm=%3d",
      "?ha=1&confirm=%3e",
      "/?ha=1&confirm=%3e",
      "?ha=1&confirm=%3f",
      "/?ha=1&confirm=%3f",
      "?ha=1&confirm=%40",
      "/?ha=1&confirm=%40",
      "?ha=1&confirm=%41",
      "/?ha=1&confirm=%41",
      "?ha=1&confirm=%42",
      "/?ha=1&confirm=%42",
      "?ha=1&confirm=%43",
      "/?ha=1&confirm=%43",
      "?ha=1&confirm=%44",
      "/?ha=1&confirm=%44",
      "?ha=1&confirm=%45",
      "/?ha=1&confirm=%45",
      "?ha=1&confirm=%46",
      "/?ha=1&confirm=%46",
      "?ha=1&confirm=%47",
      "/?ha=1&confirm=%47",
      "?ha=1&confirm=%48",
      "/?ha=1&confirm=%48",
      "?ha=1&confirm=%49",
      "/?ha=1&confirm=%49",
      "?ha=1&confirm=%4a",
      "/?ha=1&confirm=%4a",
      "?ha=1&confirm=%4b",
      "/?ha=1&confirm=%4b",
      "?ha=1&confirm=%4c",
      "/?ha=1&confirm=%4c",
      "?ha=1&confirm=%4d",
      "/?ha=1&confirm=%4d",
      "?ha=1&confirm=%4e",
      "/?ha=1&confirm=%4e",
      "?ha=1&confirm=%4f",
      "/?ha=1&confirm=%4f",
      "?ha=1&confirm=%50",
      "/?ha=1&confirm=%50",
      "?ha=1&confirm=%51",
      "/?ha=1&confirm=%51",
      "?ha=1&confirm=%52",
      "/?ha=1&confirm=%52",
      "?ha=1&confirm=%53",
      "/?ha=1&confirm=%53",
      "?ha=1&confirm=%54",
      "/?ha=1&confirm=%54",
      "?ha=1&confirm=%55",
      "/?ha=1&confirm=%55",
      "?ha=1&confirm=%56",
      "/?ha=1&confirm=%56",
      "?ha=1&confirm=%57",
      "/?ha=1&confirm=%57",
      "?ha=1&confirm=%58",
      "/?ha=1&confirm=%58",
      "?ha=1&confirm=%59",
      "/?ha=1&confirm=%59",
      "?ha=1&confirm=%5a",
      "/?ha=1&confirm=%5a",
      "?ha=1&confirm=%5b",
      "/?ha=1&confirm=%5b",
      "?ha=1&confirm=%5c",
      "/?ha=1&confirm=%5c",
      "?ha=1&confirm=%5d",
      "/?ha=1&confirm=%5d",
      "?ha=1&confirm=%5e",
      "/?ha=1&confirm=%5e",
      "?ha=1&confirm=%5f",
      "/?ha=1&confirm=%5f",
      "?ha=1&confirm=%60",
      "/?ha=1&confirm=%60",
      "?ha=1&confirm=%61",
      "/?ha=1&confirm=%61",
      "?ha=1&confirm=%62",
      "/?ha=1&confirm=%62",
      "?ha=1&confirm=%63",
      "/?ha=1&confirm=%63",
      "?ha=1&confirm=%64",
      "/?ha=1&confirm=%64",
      "?ha=1&confirm=%65",
      "/?ha=1&confirm=%65",
      "?ha=1&confirm=%66",
      "/?ha=1&confirm=%66",
      "?ha=1&confirm=%67",
      "/?ha=1&confirm=%67",
      "?ha=1&confirm=%68",
      "/?ha=1&confirm=%68",
      "?ha=1&confirm=%69",
      "/?ha=1&confirm=%69",
      "?ha=1&confirm=%6a",
      "/?ha=1&confirm=%6a",
      "?ha=1&confirm=%6b",
      "/?ha=1&confirm=%6b",
      "?ha=1&confirm=%6c",
      "/?ha=1&confirm=%6c",
      "?ha=1&confirm=%6d",
      "/?ha=1&confirm=%6d",
      "?ha=1&confirm=%6e",
      "/?ha=1&confirm=%6e",
      "?ha=1&confirm=%6f",
      "/?ha=1&confirm=%6f",
      "?ha=1&confirm=%70",
      "/?ha=1&confirm=%70",
      "?ha=1&confirm=%71",
      "/?ha=1&confirm=%71",
      "?ha=1&confirm=%72",
      "/?ha=1&confirm=%72",
      "?ha=1&confirm=%73",
      "/?ha=1&confirm=%73",
      "?ha=1&confirm=%74",
      "/?ha=1&confirm=%74",
      "?ha=1&confirm=%75",
      "/?ha=1&confirm=%75",
      "?ha=1&confirm=%76",
      "/?ha=1&confirm=%76",
      "?ha=1&confirm=%77",
      "/?ha=1&confirm=%77",
      "?ha=1&confirm=%78",
      "/?ha=1&confirm=%78",
      "?ha=1&confirm=%79",
      "/?ha=1&confirm=%79",
      "?ha=1&confirm=%7a",
      "/?ha=1&confirm=%7a",
      "?ha=1&confirm=%7b",
      "/?ha=1&confirm=%7b",
      "?ha=1&confirm=%7c",
      "/?ha=1&confirm=%7c",
      "?ha=1&confirm=%7d",
      "/?ha=1&confirm=%7d",
      "?ha=1&confirm=%7e",
      "/?ha=1&confirm=%7e",
      "?ha=1&confirm=%7f",
      "/?ha=1&confirm=%7f",
      "?ha=1&confirm=%80",
      "/?ha=1&confirm=%80",
      "?ha=1&confirm=%81",
      "/?ha=1&confirm=%81",
      "?ha=1&confirm=%82",
      "/?ha=1&confirm=%82",
      "?ha=1&confirm=%83",
      "/?ha=1&confirm=%83",
      "?ha=1&confirm=%84",
      "/?ha=1&confirm=%84",
      "?ha=1&confirm=%85",
      "/?ha=1&confirm=%85",
      "?ha=1&confirm=%86",
      "/?ha=1&confirm=%86",
      "?ha=1&confirm=%87",
      "/?ha=1&confirm=%87",
      "?ha=1&confirm=%88",
      "/?ha=1&confirm=%88",
      "?ha=1&confirm=%89",
      "/?ha=1&confirm=%89",
      "?ha=1&confirm=%8a",
      "/?ha=1&confirm=%8a",
      "?ha=1&confirm=%8b",
      "/?ha=1&confirm=%8b",
      "?ha=1&confirm=%8c",
      "/?ha=1&confirm=%8c",
      "?ha=1&confirm=%8d",
      "/?ha=1&confirm=%8d",
      "?ha=1&confirm=%8e",
      "/?ha=1&confirm=%8e",
      "?ha=1&confirm=%8f",
      "/?ha=1&confirm=%8f",
      "?n=1&confirm=%37",
      "/?n=1&confirm=%37",
      "?m=2&confirm=%37",
      "/?m=2&confirm=%37",
      "?p=3&confirm=%37",
      "/?p=3&confirm=%37",
      "?q=1&confirm=%37",
      "/?q=1&confirm=%37",
      "?r=1&confirm=%37",
      "/?r=1&confirm=%37",
      "?s=1&confirm=%37",
      "/?s=1&confirm=%37",
      "?t=1&confirm=%37",
      "/?t=1&confirm=%37",
    ] as const;
    for (const query of queries) {
      const keepRaw = "keep-sg02-token";
      const dropRaw = "drop-macos-token";
      const ctx = await startConsole({
        tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=macos-dev&confirm=1",
        });
        expect(res.status, query).toBe(200);
        const html = await res.text();
        expect(html, query).toContain("1 issued");
        expect(html).toContain("sg02");
        expect(html).not.toContain("macos-dev");
        const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
        expect(map.get(hashToken(keepRaw))).toBe("sg02");
        expect(map.get(hashToken(dropRaw))).toBeUndefined();
      } finally {
        await ctx.close();
      }
    }
  }, 120_000);

  it("refuses POST /console/revoke with remaining short confirm-later queries when confirm is only in the query", async () => {
    const keys = [
      "u",
      "v",
      "w",
      "x",
      "y",
      "z",
      ...Array.from({ length: 26 }, (_, p) =>
        Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(97 + p)}${String.fromCharCode(97 + i)}`),
      ).flat(),
    ];
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      for (const key of keys) {
        for (const prefix of ["?", "/?"] as const) {
          const query = `${prefix}${key}=1&confirm=%37`;
          const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, { redirect: "manual" });
          expect(get.status, query).toBe(302);
          expect(get.headers.get("location"), query).toBe("/console");

          const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "host_id=macos-dev",
          });
          expect(res.status, query).toBe(400);
          const html = await res.text();
          expect(html, query).toContain("Revoke requires confirmation.");
          expect(html).toContain("macos-dev");
          expect(html).toContain("sg02");
          const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
          expect(map.get(hashToken(keepRaw))).toBe("sg02");
          expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
        }
      }
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("revokes a host-id on POST /console/revoke with remaining short confirm-later queries and a valid body", async () => {
    const keys = [
      "u",
      "v",
      "w",
      "x",
      "y",
      "z",
      ...Array.from({ length: 26 }, (_, p) =>
        Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(97 + p)}${String.fromCharCode(97 + i)}`),
      ).flat(),
    ];
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      for (const key of keys) {
        for (const prefix of ["?", "/?"] as const) {
          const query = `${prefix}${key}=1&confirm=%37`;
          if (!parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).has(hashToken(dropRaw))) {
            const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "host_id=macos-dev",
            });
            expect(issued.status, query).toBe(200);
          }
          const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "host_id=macos-dev&confirm=1",
          });
          expect(res.status, query).toBe(200);
          const html = await res.text();
          expect(html, query).toContain("1 issued");
          expect(html, query).toContain("sg02");
          expect(html).not.toContain("macos-dev");
          const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
          expect(map.get(hashToken(keepRaw))).toBe("sg02");
          expect(map.get(hashToken(dropRaw))).toBeUndefined();
        }
      }
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("revokes a host-id on POST /console/revoke?confirm=%31 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?confirm=%31`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=%31 with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%31`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=%31`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke with whitespace confirm queries", async () => {
    const queries = ["/?confirm=%20", "?confirm=%09", "?confirm=%0a", "?confirm=++", "/?confirm=%09"] as const;
    for (const query of queries) {
      const keepRaw = "keep-sg02-token";
      const dropRaw = "drop-macos-token";
      const ctx = await startConsole({
        tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=macos-dev&confirm=1",
        });
        expect(res.status, query).toBe(200);
        const html = await res.text();
        expect(html, query).toContain("1 issued");
        expect(html).toContain("sg02");
        expect(html).not.toContain("macos-dev");
        const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
        expect(map.get(hashToken(keepRaw))).toBe("sg02");
        expect(map.get(hashToken(dropRaw))).toBeUndefined();
      } finally {
        await ctx.close();
      }
    }
  });

  it("revokes a host-id on POST /console/revoke/?confirm=+ with a valid body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?confirm=+`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%20", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%20`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%20`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg29",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg29");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg29"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg29");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%31", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%31`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%31`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg35",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg35");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg35"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg35");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%31", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%31`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%31`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg36",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg36");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg36"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg36");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%32", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%32`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%32`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg37",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg37");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg37"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg37");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%32", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%32`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%32`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg38",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg38");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg38"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg38");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%30", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%30`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%30`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg39",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg39");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg39"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg39");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%30", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%30`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%30`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg40",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg40");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg40"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg40");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%33", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%33`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%33`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg41",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg41");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg41"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg41");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%33", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%33`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%33`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg42",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg42");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg42"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg42");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%34", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%34`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%34`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg43",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg43");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg43"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg43");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%34", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%34`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%34`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg44",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg44");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg44"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg44");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%35", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%35`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%35`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg45",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg45");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg45"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg45");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%35", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%35`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%35`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg46",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg46");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg46"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg46");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%36", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%36`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%36`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg47",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg47");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg47"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg47");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue/?confirm=%36", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%36`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?confirm=%36`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg48",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg48");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg48"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg48");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?confirm=%37", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%37`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg49",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg49");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg49"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg49");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?qux=4&confirm=%37", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?qux=4&confirm=%37`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?qux=4&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg95",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg95");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg95"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg95");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?u=1&confirm=%37", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?u=1&confirm=%37`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?u=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg149",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg149");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg149"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg149");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%37", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%37`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha1");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha1"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha1");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%37 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%37 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%38", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%38`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%38`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha138",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha138");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha138"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha138");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%38 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%38`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%38 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%38`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%39", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%39`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%39`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha139",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha139");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha139"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha139");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%39 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%39`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%39 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%39`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%3a", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3a`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3a`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha13a",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha13a");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha13a"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha13a");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%3a when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3a`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%3a when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%3a`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%3b", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3b`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3b`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha13b",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha13b");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha13b"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha13b");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%3b when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3b`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%3b when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%3b`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%3c", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3c`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3c`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha13c",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha13c");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha13c"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha13c");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%3c when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3c`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%3c when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%3c`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%3d", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3d`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3d`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha13d",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha13d");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha13d"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha13d");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%3d when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3d`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%3d when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%3d`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%3e", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3e`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3e`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha13e",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha13e");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha13e"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha13e");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%3e when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%3e`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%3e when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%3e`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%58", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%58`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%58`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha158",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha158");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha158"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha158");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%58 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%58`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%58 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%58`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?ha=1&confirm=%90", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%90`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%90`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgha190",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgha190");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgha190"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgha190");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?ha=1&confirm=%90 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?ha=1&confirm=%90`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?ha=1&confirm=%90 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?ha=1&confirm=%90`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue?aaa=1&confirm=%37", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?aaa=1&confirm=%37`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?aaa=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgaaa1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgaaa1");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgaaa1"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgaaa1");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?aaa=1&confirm=%37 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?aaa=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?aaa=1&confirm=%37 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?aaa=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with charset=utf-8", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "host_id=sgct01",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgct01");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgct01"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct01");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue without a Content-Type header", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        body: "host_id=sgct02",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct02");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct02");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with an unused extra body field", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "unused=1&host_id=sgct03",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct03");
      expect(html).not.toContain("unused=1");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct03");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue when the body is JSON", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_id: "sgct04" }),
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).not.toMatch(/data-once-bearer=/);
      expect(html).not.toContain("sgct04");
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke with charset=utf-8 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with text/plain urlencoded body", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "host_id=sgct05",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sgct05");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgct05"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct05");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with charset=UTF-8", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "host_id=sgct06",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct06");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct06");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues the first host_id when the form repeats the field", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgct07&host_id=sgct08",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct07");
      expect(html).not.toContain("sgct08");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect([...map.values()].sort()).toEqual(["sg02", "sgct07"]);
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct07");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke with an unused extra body field", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "unused=1&host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with quoted charset utf-8", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": 'application/x-www-form-urlencoded; charset="utf-8"' },
        body: "host_id=sgct09",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct09");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct09");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with a trailing unused body field", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sgct10&unused=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct10");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct10");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue when Content-Type is JSON but the body is urlencoded", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "host_id=sgct11",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct11");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct11");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke with a text/plain urlencoded body", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with octet-stream urlencoded body", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "host_id=sgct12",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct12");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct12");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue with multipart Content-Type and a urlencoded body", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data" },
        body: "host_id=sgct13",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct13");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct13");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues HTML on POST /console/issue even when Accept is application/json", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "host_id=sgct14",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgct14");
      expect(html.startsWith("{")).toBe(false);
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sgct14");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML on GET /console even when Accept is application/json", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console`, {
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("sg02");
      expect(html).not.toContain(keepRaw);
      expect(html.startsWith("{")).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/issue even when Accept is application/json", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/console");
      const body = await res.text();
      expect(body).toBe("");
      expect(body.startsWith("{")).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("redirects GET /console/revoke even when Accept is application/json", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/console");
      const body = await res.text();
      expect(body).toBe("");
      expect(body.startsWith("{")).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML on POST /console/revoke even when Accept is application/json", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html.startsWith("{")).toBe(false);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML on GET /console/ even when Accept is application/json", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/`, {
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("sg02");
      expect(html).not.toContain(keepRaw);
      expect(html.startsWith("{")).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("issues a host-id on POST /console/issue even with Authorization of an existing map token", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${keepRaw}`,
        },
        body: "host_id=sgauth01",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sgauth01");
      expect(html).toContain("sg02");
      expect(html).not.toContain(keepRaw);
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(raw).not.toBe(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sgauth01"]);

      const keepMcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(keepMcp.status).toBe(200);
      const keepBody = (await keepMcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(keepBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(keepBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const newMcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(newMcp.status).toBe(200);
      const newBody = (await newMcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(newBody.result?.structuredContent?.writer_id).toBe("sgauth01");
      expect(newBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("revokes the form host-id on POST /console/revoke even with Authorization of a sibling token", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${keepRaw}`,
        },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBeUndefined();

      const keepMcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(keepMcp.status).toBe(200);
      const keepBody = (await keepMcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(keepBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(keepBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues host-ids on POST /console/issue?ha=1 with remaining encoded confirm queries", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const rows = HA_CONFIRM_ENC.map((enc) => [`%${enc}`, `sgha1${enc}`] as const);
      for (const [enc, hostId] of rows) {
        for (const prefix of ["?", "/?"] as const) {
          const path = `/console/issue${prefix}ha=1&confirm=${enc}`;
          const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
          expect(get.status, path).toBe(302);
          expect(get.headers.get("location"), path).toBe("/console");

          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `host_id=${hostId}${prefix === "/?" ? "s" : ""}`,
          });
          expect(res.status, path).toBe(200);
          const html = await res.text();
          expect(html, path).toMatch(/data-once-bearer=/);
          const issued = prefix === "/?" ? `${hostId}s` : hostId;
          expect(html, path).toContain(issued);
          expect(html).toContain("sg02");
          expect(html).not.toContain(keepRaw);
          const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
          expect(raw, path).toBeTruthy();
          const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${raw}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "wiki_context", arguments: {} },
            }),
          });
          expect(mcp.status, path).toBe(200);
          const mcpBody = (await mcp.json()) as {
            result?: { structuredContent?: { writer_id?: string } };
          };
          expect(mcpBody.result?.structuredContent?.writer_id, path).toBe(issued);
          expect(mcpBody.result?.structuredContent?.writer_id, path).not.toBe("chatgpt-web");
        }
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("refuses POST /console/issue?ha=1 with remaining encoded confirm queries when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const enc of HA_CONFIRM_ENC) {
        for (const prefix of ["?", "/?"] as const) {
          const path = `/console/issue${prefix}ha=1&confirm=%${enc}`;
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "host_id=",
          });
          expect(res.status, path).toBe(400);
          const html = await res.text();
          expect(html, path).toContain("Invalid host-id.");
          expect(html).toContain("sg02");
          expect(html).not.toMatch(/data-once-bearer=/);
        }
      }
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("refuses POST /console/revoke?ha=1 with remaining encoded confirm queries when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      for (const enc of ["3e", ...HA_CONFIRM_ENC]) {
        for (const prefix of ["?", "/?"] as const) {
          const query = `${prefix}ha=1&confirm=%${enc}`;
          const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "host_id=macos-dev&confirm=0",
          });
          expect(res.status, query).toBe(400);
          const html = await res.text();
          expect(html, query).toContain("Revoke requires confirmation.");
          expect(html).toContain("macos-dev");
          expect(html).toContain("sg02");
        }
      }
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("refuses POST /console/issue?u=1&confirm=%37 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?u=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?u=1&confirm=%37 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?u=1&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?qux=4&confirm=%37 when body host_id is empty", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?qux=4&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Invalid host-id.");
      expect(html).toContain("sg02");
      expect(html).toContain("1 issued");
      expect(html).not.toMatch(/data-once-bearer=/);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()]).toEqual(["sg02"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue?qux=4&confirm=%37 when body host_id is whitespace", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const body of ["host_id=%20", "host_id=+", "host_id=%09", "host_id=%0a"] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?qux=4&confirm=%37`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        expect(res.status, body).toBe(400);
        const html = await res.text();
        expect(html, body).toContain("Invalid host-id.");
        expect(html).toContain("sg02");
        expect(html).not.toMatch(/data-once-bearer=/);
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
      }
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?qux=4&confirm=%37 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke?qux=4&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke/?qux=4&confirm=%37 when body confirm is 0", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/?qux=4&confirm=%37`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=0",
      });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("issues host-ids on POST /console/issue with remaining encoded confirm queries", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const [path, hostId] of [
        ["/console/issue/?confirm=%37", "sg50"],
        ["/console/issue?confirm=%38", "sg51"],
        ["/console/issue/?confirm=%38", "sg52"],
        ["/console/issue?confirm=%39", "sg53"],
        ["/console/issue/?confirm=%39", "sg54"],
        ["/console/issue?confirm=%2b", "sg55"],
        ["/console/issue/?confirm=%2b", "sg56"],
        ["/console/issue?confirm=%37&page=0", "sg57"],
        ["/console/issue/?confirm=%37&foo=1", "sg58"],
        ["/console/issue?confirm=%25", "sg59"],
        ["/console/issue/?confirm=%25", "sg60"],
        ["/console/issue?confirm=%41", "sg61"],
        ["/console/issue/?confirm=%41", "sg62"],
        ["/console/issue?confirm=%61", "sg63"],
        ["/console/issue/?confirm=%61", "sg64"],
        ["/console/issue?confirm=%3d", "sg65"],
        ["/console/issue/?confirm=%3d", "sg66"],
        ["/console/issue?confirm=%26", "sg67"],
        ["/console/issue/?confirm=%26", "sg68"],
        ["/console/issue?confirm=%7e", "sg69"],
        ["/console/issue/?confirm=%7e", "sg70"],
        ["/console/issue?confirm=%2f", "sg71"],
        ["/console/issue/?confirm=%2f", "sg72"],
        ["/console/issue?confirm=%2a", "sg73"],
        ["/console/issue/?confirm=%2a", "sg74"],
        ["/console/issue?confirm=%23", "sg75"],
        ["/console/issue/?confirm=%23", "sg76"],
        ["/console/issue?confirm=%40", "sg77"],
        ["/console/issue/?confirm=%40", "sg78"],
        ["/console/issue?confirm=%5b", "sg79"],
        ["/console/issue/?confirm=%5b", "sg80"],
        ["/console/issue?confirm=%5d", "sg81"],
        ["/console/issue/?confirm=%5d", "sg82"],
        ["/console/issue?confirm=%7c", "sg83"],
        ["/console/issue/?confirm=%7c", "sg84"],
        ["/console/issue?confirm=%3f", "sg85"],
        ["/console/issue/?confirm=%3f", "sg86"],
        ["/console/issue?page=0&confirm=%37", "sg87"],
        ["/console/issue?foo=1&confirm=%37", "sg88"],
        ["/console/issue?page=2&confirm=%37", "sg89"],
        ["/console/issue/?page=0&confirm=%37", "sg90"],
        ["/console/issue?bar=2&confirm=%37", "sg91"],
        ["/console/issue/?bar=2&confirm=%37", "sg92"],
        ["/console/issue?baz=3&confirm=%37", "sg93"],
        ["/console/issue/?baz=3&confirm=%37", "sg94"],
        ["/console/issue/?qux=4&confirm=%37", "sg96"],
        ["/console/issue?quux=5&confirm=%37", "sg97"],
        ["/console/issue/?quux=5&confirm=%37", "sg98"],
        ["/console/issue?corge=6&confirm=%37", "sg99"],
        ["/console/issue/?corge=6&confirm=%37", "sg100"],
        ["/console/issue?grault=7&confirm=%37", "sg101"],
        ["/console/issue/?grault=7&confirm=%37", "sg102"],
        ["/console/issue?garply=8&confirm=%37", "sg103"],
        ["/console/issue/?garply=8&confirm=%37", "sg104"],
        ["/console/issue?waldo=9&confirm=%37", "sg105"],
        ["/console/issue/?waldo=9&confirm=%37", "sg106"],
        ["/console/issue?fred=10&confirm=%37", "sg107"],
        ["/console/issue/?fred=10&confirm=%37", "sg108"],
        ["/console/issue?plugh=11&confirm=%37", "sg109"],
        ["/console/issue/?plugh=11&confirm=%37", "sg110"],
        ["/console/issue?xyzzy=12&confirm=%37", "sg111"],
        ["/console/issue/?xyzzy=12&confirm=%37", "sg112"],
        ["/console/issue?thud=13&confirm=%37", "sg113"],
        ["/console/issue/?thud=13&confirm=%37", "sg114"],
        ["/console/issue?spam=1&confirm=%37", "sg115"],
        ["/console/issue/?spam=1&confirm=%37", "sg116"],
        ["/console/issue?eggs=2&confirm=%37", "sg117"],
        ["/console/issue/?eggs=2&confirm=%37", "sg118"],
        ["/console/issue?ham=3&confirm=%37", "sg119"],
        ["/console/issue/?ham=3&confirm=%37", "sg120"],
        ["/console/issue?confirm=%37&qux=4", "sg121"],
        ["/console/issue/?confirm=%37&qux=4", "sg122"],
        ["/console/issue?qux=4&page=0&confirm=%37", "sg123"],
        ["/console/issue?qux=4&foo=1&confirm=%37", "sg124"],
        ["/console/issue?foo=1&bar=2&confirm=%37", "sg125"],
        ["/console/issue/?foo=1&bar=2&confirm=%37", "sg126"],
        ["/console/issue?foo=1&bar=2&baz=3&confirm=%37", "sg127"],
        ["/console/issue?foo=1&bar=2&baz=3&qux=4&confirm=%37", "sg128"],
        ["/console/issue?confirm=%37&foo=1&bar=2", "sg129"],
        ["/console/issue?a=1&b=2&c=3&d=4&e=5&confirm=%37", "sg130"],
        ["/console/issue?qux=4&confirm=%38", "sg131"],
        ["/console/issue/?qux=4&confirm=%38", "sg132"],
        ["/console/issue?ha=1&confirm=%38", "sg2000"],
        ["/console/issue/?ha=1&confirm=%38", "sg2001"],
        ["/console/issue?qux=4&confirm=%39", "sg133"],
        ["/console/issue/?qux=4&confirm=%39", "sg134"],
        ["/console/issue?ha=1&confirm=%39", "sg2002"],
        ["/console/issue/?ha=1&confirm=%39", "sg2003"],
        ["/console/issue?ha=1&confirm=%3a", "sg2004"],
        ["/console/issue/?ha=1&confirm=%3a", "sg2005"],
        ["/console/issue?ha=1&confirm=%3b", "sg2006"],
        ["/console/issue/?ha=1&confirm=%3b", "sg2007"],
        ["/console/issue?ha=1&confirm=%3c", "sg2008"],
        ["/console/issue/?ha=1&confirm=%3c", "sg2009"],
        ["/console/issue?ha=1&confirm=%3d", "sg2010"],
        ["/console/issue/?ha=1&confirm=%3d", "sg2011"],
        ["/console/issue?ha=1&confirm=%3e", "sg2012"],
        ["/console/issue/?ha=1&confirm=%3e", "sg2013"],
        ["/console/issue?ha=1&confirm=%3f", "sg2014"],
        ["/console/issue/?ha=1&confirm=%3f", "sg2015"],
        ["/console/issue?ha=1&confirm=%40", "sg2016"],
        ["/console/issue/?ha=1&confirm=%40", "sg2017"],
        ["/console/issue?ha=1&confirm=%41", "sg2018"],
        ["/console/issue/?ha=1&confirm=%41", "sg2019"],
        ["/console/issue?ha=1&confirm=%42", "sg2020"],
        ["/console/issue/?ha=1&confirm=%42", "sg2021"],
        ["/console/issue?ha=1&confirm=%43", "sg2022"],
        ["/console/issue/?ha=1&confirm=%43", "sg2023"],
        ["/console/issue?ha=1&confirm=%44", "sg2024"],
        ["/console/issue/?ha=1&confirm=%44", "sg2025"],
        ["/console/issue?ha=1&confirm=%45", "sg2026"],
        ["/console/issue/?ha=1&confirm=%45", "sg2027"],
        ["/console/issue?ha=1&confirm=%46", "sg2028"],
        ["/console/issue/?ha=1&confirm=%46", "sg2029"],
        ["/console/issue?ha=1&confirm=%47", "sg2030"],
        ["/console/issue/?ha=1&confirm=%47", "sg2031"],
        ["/console/issue?ha=1&confirm=%48", "sg2032"],
        ["/console/issue/?ha=1&confirm=%48", "sg2033"],
        ["/console/issue?ha=1&confirm=%49", "sg2034"],
        ["/console/issue/?ha=1&confirm=%49", "sg2035"],
        ["/console/issue?ha=1&confirm=%4a", "sg2036"],
        ["/console/issue/?ha=1&confirm=%4a", "sg2037"],
        ["/console/issue?ha=1&confirm=%4b", "sg2038"],
        ["/console/issue/?ha=1&confirm=%4b", "sg2039"],
        ["/console/issue?ha=1&confirm=%4c", "sg2040"],
        ["/console/issue/?ha=1&confirm=%4c", "sg2041"],
        ["/console/issue?ha=1&confirm=%4d", "sg2042"],
        ["/console/issue/?ha=1&confirm=%4d", "sg2043"],
        ["/console/issue?ha=1&confirm=%4e", "sg2044"],
        ["/console/issue/?ha=1&confirm=%4e", "sg2045"],
        ["/console/issue?ha=1&confirm=%4f", "sg2046"],
        ["/console/issue/?ha=1&confirm=%4f", "sg2047"],
        ["/console/issue?ha=1&confirm=%50", "sg2048"],
        ["/console/issue/?ha=1&confirm=%50", "sg2049"],
        ["/console/issue?ha=1&confirm=%51", "sg2050"],
        ["/console/issue/?ha=1&confirm=%51", "sg2051"],
        ["/console/issue?ha=1&confirm=%52", "sg2052"],
        ["/console/issue/?ha=1&confirm=%52", "sg2053"],
        ["/console/issue?ha=1&confirm=%53", "sg2054"],
        ["/console/issue/?ha=1&confirm=%53", "sg2055"],
        ["/console/issue?ha=1&confirm=%54", "sg2056"],
        ["/console/issue/?ha=1&confirm=%54", "sg2057"],
        ["/console/issue?ha=1&confirm=%55", "sg2058"],
        ["/console/issue/?ha=1&confirm=%55", "sg2059"],
        ["/console/issue?ha=1&confirm=%56", "sg2060"],
        ["/console/issue/?ha=1&confirm=%56", "sg2061"],
        ["/console/issue?ha=1&confirm=%57", "sg2062"],
        ["/console/issue/?ha=1&confirm=%57", "sg2063"],
        ["/console/issue?ha=1&confirm=%58", "sg2064"],
        ["/console/issue/?ha=1&confirm=%58", "sg2065"],
        ["/console/issue?ha=1&confirm=%59", "sg2066"],
        ["/console/issue/?ha=1&confirm=%59", "sg2067"],
        ["/console/issue?ha=1&confirm=%5a", "sg2068"],
        ["/console/issue/?ha=1&confirm=%5a", "sg2069"],
        ["/console/issue?ha=1&confirm=%5b", "sg2070"],
        ["/console/issue/?ha=1&confirm=%5b", "sg2071"],
        ["/console/issue?ha=1&confirm=%5c", "sg2072"],
        ["/console/issue/?ha=1&confirm=%5c", "sg2073"],
        ["/console/issue?ha=1&confirm=%5d", "sg2074"],
        ["/console/issue/?ha=1&confirm=%5d", "sg2075"],
        ["/console/issue?ha=1&confirm=%5e", "sg2076"],
        ["/console/issue/?ha=1&confirm=%5e", "sg2077"],
        ["/console/issue?ha=1&confirm=%5f", "sg2078"],
        ["/console/issue/?ha=1&confirm=%5f", "sg2079"],
        ["/console/issue?ha=1&confirm=%60", "sg2080"],
        ["/console/issue/?ha=1&confirm=%60", "sg2081"],
        ["/console/issue?ha=1&confirm=%61", "sg2082"],
        ["/console/issue/?ha=1&confirm=%61", "sg2083"],
        ["/console/issue?ha=1&confirm=%62", "sg2084"],
        ["/console/issue/?ha=1&confirm=%62", "sg2085"],
        ["/console/issue?ha=1&confirm=%63", "sg2086"],
        ["/console/issue/?ha=1&confirm=%63", "sg2087"],
        ["/console/issue?ha=1&confirm=%64", "sg2088"],
        ["/console/issue/?ha=1&confirm=%64", "sg2089"],
        ["/console/issue?ha=1&confirm=%65", "sg2090"],
        ["/console/issue/?ha=1&confirm=%65", "sg2091"],
        ["/console/issue?ha=1&confirm=%66", "sg2092"],
        ["/console/issue/?ha=1&confirm=%66", "sg2093"],
        ["/console/issue?ha=1&confirm=%67", "sg2094"],
        ["/console/issue/?ha=1&confirm=%67", "sg2095"],
        ["/console/issue?ha=1&confirm=%68", "sg2096"],
        ["/console/issue/?ha=1&confirm=%68", "sg2097"],
        ["/console/issue?ha=1&confirm=%69", "sg2098"],
        ["/console/issue/?ha=1&confirm=%69", "sg2099"],
        ["/console/issue?ha=1&confirm=%6a", "sg2100"],
        ["/console/issue/?ha=1&confirm=%6a", "sg2101"],
        ["/console/issue?ha=1&confirm=%6b", "sg2102"],
        ["/console/issue/?ha=1&confirm=%6b", "sg2103"],
        ["/console/issue?ha=1&confirm=%6c", "sg2104"],
        ["/console/issue/?ha=1&confirm=%6c", "sg2105"],
        ["/console/issue?ha=1&confirm=%6d", "sg2106"],
        ["/console/issue/?ha=1&confirm=%6d", "sg2107"],
        ["/console/issue?ha=1&confirm=%6e", "sg2108"],
        ["/console/issue/?ha=1&confirm=%6e", "sg2109"],
        ["/console/issue?ha=1&confirm=%6f", "sg2110"],
        ["/console/issue/?ha=1&confirm=%6f", "sg2111"],
        ["/console/issue?ha=1&confirm=%70", "sg2112"],
        ["/console/issue/?ha=1&confirm=%70", "sg2113"],
        ["/console/issue?ha=1&confirm=%71", "sg2114"],
        ["/console/issue/?ha=1&confirm=%71", "sg2115"],
        ["/console/issue?ha=1&confirm=%72", "sg2116"],
        ["/console/issue/?ha=1&confirm=%72", "sg2117"],
        ["/console/issue?ha=1&confirm=%73", "sg2118"],
        ["/console/issue/?ha=1&confirm=%73", "sg2119"],
        ["/console/issue?ha=1&confirm=%74", "sg2120"],
        ["/console/issue/?ha=1&confirm=%74", "sg2121"],
        ["/console/issue?ha=1&confirm=%75", "sg2122"],
        ["/console/issue/?ha=1&confirm=%75", "sg2123"],
        ["/console/issue?ha=1&confirm=%76", "sg2124"],
        ["/console/issue/?ha=1&confirm=%76", "sg2125"],
        ["/console/issue?ha=1&confirm=%77", "sg2126"],
        ["/console/issue/?ha=1&confirm=%77", "sg2127"],
        ["/console/issue?ha=1&confirm=%78", "sg2128"],
        ["/console/issue/?ha=1&confirm=%78", "sg2129"],
        ["/console/issue?ha=1&confirm=%79", "sg2130"],
        ["/console/issue/?ha=1&confirm=%79", "sg2131"],
        ["/console/issue?ha=1&confirm=%7a", "sg2132"],
        ["/console/issue/?ha=1&confirm=%7a", "sg2133"],
        ["/console/issue?ha=1&confirm=%7b", "sg2134"],
        ["/console/issue/?ha=1&confirm=%7b", "sg2135"],
        ["/console/issue?ha=1&confirm=%7c", "sg2136"],
        ["/console/issue/?ha=1&confirm=%7c", "sg2137"],
        ["/console/issue?ha=1&confirm=%7d", "sg2138"],
        ["/console/issue/?ha=1&confirm=%7d", "sg2139"],
        ["/console/issue?ha=1&confirm=%7e", "sg2140"],
        ["/console/issue/?ha=1&confirm=%7e", "sg2141"],
        ["/console/issue?ha=1&confirm=%7f", "sg2142"],
        ["/console/issue/?ha=1&confirm=%7f", "sg2143"],
        ["/console/issue?ha=1&confirm=%80", "sg2144"],
        ["/console/issue/?ha=1&confirm=%80", "sg2145"],
        ["/console/issue?ha=1&confirm=%81", "sg2146"],
        ["/console/issue/?ha=1&confirm=%81", "sg2147"],
        ["/console/issue?ha=1&confirm=%82", "sg2148"],
        ["/console/issue/?ha=1&confirm=%82", "sg2149"],
        ["/console/issue?ha=1&confirm=%83", "sg2150"],
        ["/console/issue/?ha=1&confirm=%83", "sg2151"],
        ["/console/issue?ha=1&confirm=%84", "sg2152"],
        ["/console/issue/?ha=1&confirm=%84", "sg2153"],
        ["/console/issue?ha=1&confirm=%85", "sg2154"],
        ["/console/issue/?ha=1&confirm=%85", "sg2155"],
        ["/console/issue?ha=1&confirm=%86", "sg2156"],
        ["/console/issue/?ha=1&confirm=%86", "sg2157"],
        ["/console/issue?ha=1&confirm=%87", "sg2158"],
        ["/console/issue/?ha=1&confirm=%87", "sg2159"],
        ["/console/issue?ha=1&confirm=%88", "sg2160"],
        ["/console/issue/?ha=1&confirm=%88", "sg2161"],
        ["/console/issue?ha=1&confirm=%89", "sg2162"],
        ["/console/issue/?ha=1&confirm=%89", "sg2163"],
        ["/console/issue?ha=1&confirm=%8a", "sg2164"],
        ["/console/issue/?ha=1&confirm=%8a", "sg2165"],
        ["/console/issue?ha=1&confirm=%8b", "sg2166"],
        ["/console/issue/?ha=1&confirm=%8b", "sg2167"],
        ["/console/issue?ha=1&confirm=%8c", "sg2168"],
        ["/console/issue/?ha=1&confirm=%8c", "sg2169"],
        ["/console/issue?ha=1&confirm=%8d", "sg2170"],
        ["/console/issue/?ha=1&confirm=%8d", "sg2171"],
        ["/console/issue?ha=1&confirm=%8e", "sg2172"],
        ["/console/issue/?ha=1&confirm=%8e", "sg2173"],
        ["/console/issue?ha=1&confirm=%8f", "sg2174"],
        ["/console/issue/?ha=1&confirm=%8f", "sg2175"],
        ["/console/issue?n=1&confirm=%37", "sg135"],
        ["/console/issue/?n=1&confirm=%37", "sg136"],
        ["/console/issue?m=2&confirm=%37", "sg137"],
        ["/console/issue/?m=2&confirm=%37", "sg138"],
        ["/console/issue?p=3&confirm=%37", "sg139"],
        ["/console/issue/?p=3&confirm=%37", "sg140"],
        ["/console/issue?q=1&confirm=%37", "sg141"],
        ["/console/issue/?q=1&confirm=%37", "sg142"],
        ["/console/issue?r=1&confirm=%37", "sg143"],
        ["/console/issue/?r=1&confirm=%37", "sg144"],
        ["/console/issue?s=1&confirm=%37", "sg145"],
        ["/console/issue/?s=1&confirm=%37", "sg146"],
        ["/console/issue?t=1&confirm=%37", "sg147"],
        ["/console/issue/?t=1&confirm=%37", "sg148"],
      ] as const) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status, path).toBe(302);
        expect(get.headers.get("location"), path).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${hostId}`,
        });
        expect(res.status, path).toBe(200);
        const html = await res.text();
        expect(html, path).toMatch(/data-once-bearer=/);
        expect(html, path).toContain(hostId);
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      const encodedMap = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(encodedMap.get(hashToken(keepRaw))).toBe("sg02");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("issues host-ids on POST /console/issue with remaining short confirm-later queries", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const keys = [
        "u",
        "v",
        "w",
        "x",
        "y",
        "z",
        ...Array.from({ length: 26 }, (_, p) =>
          Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(97 + p)}${String.fromCharCode(97 + i)}`),
        ).flat(),
      ];
      let n = 150;
      const rows: Array<[string, string]> = [];
      for (const key of keys) {
        if (key !== "u") {
          rows.push([`/console/issue?${key}=1&confirm=%37`, `sg${n++}`]);
        }
        rows.push([`/console/issue/?${key}=1&confirm=%37`, `sg${n++}`]);
      }
      for (const [path, hostId] of rows) {
        const get = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
        expect(get.status, path).toBe(302);
        expect(get.headers.get("location"), path).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${hostId}`,
        });
        expect(res.status, path).toBe(200);
        const html = await res.text();
        expect(html, path).toMatch(/data-once-bearer=/);
        expect(html, path).toContain(hostId);
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
      }
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.size).toBe(1 + rows.length);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("issues a host-id on POST /console/issue with whitespace confirm queries", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const [path, hostId] of [
        ["/console/issue/?confirm=%20", "sg30"],
        ["/console/issue?confirm=%09", "sg31"],
        ["/console/issue?confirm=%0a", "sg32"],
        ["/console/issue?confirm=++", "sg33"],
        ["/console/issue/?confirm=%09", "sg34"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `host_id=${hostId}`,
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/data-once-bearer=/);
        expect(html).toContain(hostId);
        expect(html).toContain("sg02");
        expect(html).not.toContain(keepRaw);
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
        expect([...parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values()]).toContain(hostId);
      }
    } finally {
      await ctx.close();
    }
  });

  it("issues the body host-id on POST /console/issue/?host_id=+", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const get = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?host_id=+`, { redirect: "manual" });
      expect(get.status).toBe(302);
      expect(get.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/?host_id=+`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg28",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("2 issued");
      expect(html).toContain("sg28");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg28"]);

      const mcp = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(mcp.status).toBe(200);
      const mcpBody = (await mcp.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(mcpBody.result?.structuredContent?.writer_id).toBe("sg28");
      expect(mcpBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");
    } finally {
      await ctx.close();
    }
  });

  it("issues the body host-id on POST /console/issue?host_id=+", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=+`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg27",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sg27");
      expect(html).toContain("sg02");
      const raw = html.match(/data-once-bearer="([^"]+)"/)?.[1];
      expect(raw).toBeTruthy();
      expect(html).not.toContain(keepRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg27"]);
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke?host_id=macos-dev&confirm=1 when body host_id is %09", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${ctx.port}/console/revoke?host_id=macos-dev&confirm=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=%09&confirm=1",
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Revoke requires confirmation.");
      expect(html).toContain("macos-dev");
      expect(html).toContain("sg02");
      expect(html).toContain("2 issued");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/revoke with query host_id when body host_id is whitespace", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      for (const [path, body] of [
        ["/console/revoke/?host_id=macos-dev&confirm=1", "host_id=%20&confirm=1"],
        ["/console/revoke?host_id=macos-dev&confirm=1", "host_id=%20%20&confirm=1"],
        ["/console/revoke?host_id=macos-dev&confirm=1", "host_id=   &confirm=1"],
        ["/console/revoke/?host_id=macos-dev&confirm=1", "host_id=%20%20&confirm=1"],
        ["/console/revoke?host_id=macos-dev&confirm=1", "host_id=%09&confirm=1"],
        ["/console/revoke/?host_id=macos-dev&confirm=1", "host_id=%09&confirm=1"],
        ["/console/revoke?host_id=macos-dev&confirm=1", "host_id=%0a&confirm=1"],
        ["/console/revoke/?host_id=macos-dev&confirm=1", "host_id=+&confirm=1"],
        ["/console/revoke?host_id=macos-dev&confirm=1", "host_id=++&confirm=1"],
        ["/console/revoke/?host_id=macos-dev&confirm=1", "host_id=++&confirm=1"],
        ["/console/revoke?host_id=macos-dev&confirm=1", "host_id=macos-dev&confirm=+"],
        ["/console/revoke/?host_id=macos-dev&confirm=1", "host_id=macos-dev&confirm=+"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        expect(res.status, `${path} ${body}`).toBe(400);
        const html = await res.text();
        expect(html, `${path} ${body}`).toContain("Revoke requires confirmation.");
        expect(html).toContain("macos-dev");
        expect(html).toContain("sg02");
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(dropRaw))).toBe("macos-dev");
      }
    } finally {
      await ctx.close();
    }
  });

  it("refuses POST /console/issue with query host_id when body host_id is whitespace", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      for (const [path, body] of [
        ["/console/issue/?host_id=sg99", "host_id=%20"],
        ["/console/issue?host_id=sg99", "host_id=%20%20"],
        ["/console/issue?host_id=sg99", "host_id=   "],
        ["/console/issue/?host_id=sg99", "host_id=%20%20"],
        ["/console/issue?host_id=sg99", "host_id=%09"],
        ["/console/issue/?host_id=sg99", "host_id=%09"],
        ["/console/issue?host_id=sg99", "host_id=%0a"],
        ["/console/issue/?host_id=sg99", "host_id=%0a"],
        ["/console/issue?host_id=sg99", "host_id=+"],
        ["/console/issue/?host_id=sg99", "host_id=+"],
        ["/console/issue?host_id=sg99", "host_id=++"],
      ] as const) {
        const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        expect(res.status, `${path} ${body}`).toBe(400);
        const html = await res.text();
        expect(html, `${path} ${body}`).toContain("Invalid host-id.");
        expect(html).toContain("sg02");
        expect(html).not.toMatch(/data-once-bearer=/);
        expect(html).not.toContain("sg99");
        expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");
      }
    } finally {
      await ctx.close();
    }
  });

  it("issues the body host-id on POST /console/issue?host_id=sg99", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/issue?host_id=sg99`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg26",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/data-once-bearer=/);
      expect(html).toContain("sg26");
      expect(html).toContain("sg02");
      expect(html).not.toContain("sg99");
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect([...map.values()].sort()).toEqual(["sg02", "sg26"]);
    } finally {
      await ctx.close();
    }
  });

  it("revokes a host-id on POST /console/revoke with page and bar queries", async () => {
    const queries = [
      "/?page=0",
      "?page=1",
      "?page=-1",
      "?bar=2",
      "?foo=1&bar=2",
      "?page=999",
      "?page=foo",
      "?page=1.5",
      "/?foo=1",
      "/?bar=2",
      "/?page=1",
      "/?page=2",
      "/?foo=1&bar=2",
      "?page=2",
      "/?page=-1",
      "/?page=999",
      "/?page=foo",
      "/?page=1.5",
    ] as const;
    for (const query of queries) {
      const keepRaw = "keep-sg02-token";
      const dropRaw = "drop-macos-token";
      const ctx = await startConsole({
        tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
      });
      try {
        const get = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, { redirect: "manual" });
        expect(get.status).toBe(302);
        expect(get.headers.get("location")).toBe("/console");

        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "host_id=macos-dev&confirm=1",
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("1 issued");
        expect(html).toContain("sg02");
        expect(html).not.toContain("macos-dev");
        expect(html).not.toContain(dropRaw);
        const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
        expect(map.get(hashToken(keepRaw))).toBe("sg02");
        expect(map.get(hashToken(dropRaw))).toBeUndefined();
      } finally {
        await ctx.close();
      }
    }
  });

  it("revokes a host-id on POST /console/revoke/ trailing slash", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const redirected = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(redirected.status).toBe(302);
      expect(redirected.headers.get("location")).toBe("/console");

      const res = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("1 issued");
      expect(html).toContain("sg02");
      expect(html).not.toContain("macos-dev");
      expect(html).not.toContain(dropRaw);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.has(hashToken(dropRaw))).toBe(false);

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dropRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(revoked.status).toBe(401);
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console/issue// double slash", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const bodyText = "host_id=sg03";
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/issue//",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");

      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(issued.status).toBe(200);
      expect(await issued.text()).toMatch(/data-once-bearer=/);
      expect(new Set(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values())).toEqual(
        new Set(["sg02", "sg03"]),
      );
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console/issue/// triple slash", async () => {
    const keepRaw = "keep-sg02-token";
    const ctx = await startConsole({ tokenMapYaml: `${hashToken(keepRaw)}: sg02\n` });
    try {
      const bodyText = "host_id=sg03";
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/issue///",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("sg02");
      expect(body).toContain("1 issued");
      expect(body).not.toMatch(/data-once-bearer=/);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).get(hashToken(keepRaw))).toBe("sg02");

      const issued = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=sg03",
      });
      expect(issued.status).toBe(200);
      expect(await issued.text()).toMatch(/data-once-bearer=/);
      expect(new Set(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).values())).toEqual(
        new Set(["sg02", "sg03"]),
      );
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console/revoke// double slash", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const bodyText = "host_id=macos-dev&confirm=1";
      const { status, contentType, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/revoke//",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
      expect(body).toContain("2 issued");
      expect(body).toContain("macos-dev");
      expect(body).not.toMatch(/data-once-bearer=/);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const stillThere = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dropRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(stillThere.status).toBe(200);
      const stillBody = (await stillThere.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(stillBody.result?.structuredContent?.writer_id).toBe("macos-dev");
      expect(stillBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(revoked.status).toBe(200);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).has(hashToken(dropRaw))).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for POST /console/revoke/// triple slash", async () => {
    const keepRaw = "keep-sg02-token";
    const dropRaw = "drop-macos-token";
    const ctx = await startConsole({
      tokenMapYaml: `${hashToken(keepRaw)}: sg02\n${hashToken(dropRaw)}: macos-dev\n`,
    });
    try {
      const bodyText = "host_id=macos-dev&confirm=1";
      const { status, contentType, cacheControl, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        cacheControl: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: ctx.port,
            method: "POST",
            path: "/console/revoke///",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "Content-Length": Buffer.byteLength(bodyText),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                cacheControl: Array.isArray(res.headers["cache-control"])
                  ? res.headers["cache-control"][0]
                  : res.headers["cache-control"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(bodyText);
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(cacheControl).toBe("no-store");
      expect(body).toContain("Not found.");
      expect(body).toContain("2 issued");
      expect(body).toContain("macos-dev");
      expect(body).not.toMatch(/data-once-bearer=/);
      const map = parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8"));
      expect(map.get(hashToken(keepRaw))).toBe("sg02");
      expect(map.get(hashToken(dropRaw))).toBe("macos-dev");

      const sibling = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keepRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(sibling.status).toBe(200);
      const siblingBody = (await sibling.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(siblingBody.result?.structuredContent?.writer_id).toBe("sg02");
      expect(siblingBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const stillThere = await fetch(`http://127.0.0.1:${ctx.port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${dropRaw}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "wiki_context", arguments: {} },
        }),
      });
      expect(stillThere.status).toBe(200);
      const stillBody = (await stillThere.json()) as {
        result?: { structuredContent?: { writer_id?: string } };
      };
      expect(stillBody.result?.structuredContent?.writer_id).toBe("macos-dev");
      expect(stillBody.result?.structuredContent?.writer_id).not.toBe("chatgpt-web");

      const revoked = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "host_id=macos-dev&confirm=1",
      });
      expect(revoked.status).toBe(200);
      expect(parseTokenMap(readFileSync(ctx.tokenMapPath, "utf8")).has(hashToken(dropRaw))).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for GET /console/issue// instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "GET", path: "/console/issue//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for GET /console/revoke// instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "GET", path: "/console/revoke//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for GET /console/issue/// instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/issue/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "GET", path: "/console/issue///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for GET /console/revoke/// instead of the GET 302", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/revoke/`, { redirect: "manual" });
      expect(slash.status).toBe(302);
      expect(slash.headers.get("location")).toBe("/console");

      const { status, location, contentType, body } = await new Promise<{
        status: number;
        location: string | undefined;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "GET", path: "/console/revoke///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                location: res.headers.location,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(location).toBeUndefined();
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for GET /console// instead of the GET 200", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(slash.status).toBe(200);
      expect(await slash.text()).toContain("SkillWiki console");

      const { status, contentType, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "GET", path: "/console//" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
    } finally {
      await ctx.close();
    }
  });

  it("returns HTML 404 for GET /console/// instead of the GET 200", async () => {
    const ctx = await startConsole({ tokenMapYaml: "" });
    try {
      const slash = await fetch(`http://127.0.0.1:${ctx.port}/console/`);
      expect(slash.status).toBe(200);
      expect(await slash.text()).toContain("SkillWiki console");

      const { status, contentType, body } = await new Promise<{
        status: number;
        contentType: string | undefined;
        body: string;
      }>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: ctx.port, method: "GET", path: "/console///" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                contentType: Array.isArray(res.headers["content-type"])
                  ? res.headers["content-type"][0]
                  : res.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
      expect(contentType).toMatch(/text\/html/);
      expect(body).toContain("Not found.");
    } finally {
      await ctx.close();
    }
  });

  it("shows audit Retry when the log path is unreadable", async () => {
    const ctx = await startConsole({ tokenMapYaml: "", auditFileIsDir: true });
    try {
      const html = await (await fetch(`http://127.0.0.1:${ctx.port}/console`)).text();
      expect(html).toContain("Could not load audit. Retry.");
      expect(html).toContain('href="/console">Retry</a>');
      expect(html).not.toContain("No audit rows in this window.");
    } finally {
      await ctx.close();
    }
  });

  describe("OAuth access section", () => {
    it("hides the OAuth access section when no OAuth store is wired", async () => {
      const ctx = await startConsole({ tokenMapYaml: "" });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
        const html = await res.text();
        expect(html).not.toContain("OAuth access");
        expect(html).not.toContain("id=\"oauth-access\"");
        expect(html).not.toContain("Registered clients");
        expect(html).not.toContain("Active grants");
      } finally {
        await ctx.close();
      }
    });

    it("renders empty tables when OAuth store is wired but empty", async () => {
      const store = new InMemoryOAuthStore();
      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
        const html = await res.text();
        expect(html).toContain('<h2 id="oauth-access">OAuth access</h2>');
        expect(html).toContain("No OAuth clients registered.");
        expect(html).toContain("No active OAuth grants.");
      } finally {
        await ctx.close();
      }
    });

    it("renders registered clients and active grants with correct confirmation copy and links", async () => {
      const store = new InMemoryOAuthStore();
      await store.saveClient({
        clientId: "client-abc",
        clientName: "Claude Desktop",
        clientSecret: "super-secret-12345",
        redirectUris: ["http://localhost:3000/callback", "http://localhost:3001/callback"],
      });
      const tokenHash = hashToken("rt-secret-token-xyz");
      await store.saveRefreshToken({
        tokenHash,
        clientId: "client-abc",
        writerId: "claude-user",
        expiresAt: Date.now() + 86400_000,
        scope: "read write",
      });

      const auditRow = JSON.stringify({
        ts: new Date().toISOString(),
        host_id: "oauth-device",
        tool: "wiki_context",
        ok: true,
        ms: 12,
      });

      const ctx = await startConsole({
        tokenMapYaml: "",
        auditLines: [auditRow],
        oauthStore: store,
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
        const html = await res.text();

        // Check section and client table
        expect(html).toContain('<h2 id="oauth-access">OAuth access</h2>');
        expect(html).toContain("Claude Desktop");
        expect(html).toContain('<td class="num">2</td>'); // 2 redirect URIs
        expect(html).toContain('<td class="num">1</td>'); // 1 active grant

        // Revoke client confirmation copy cascade
        expect(html).toContain(
          "Revoke client Claude Desktop? This invalidates 1 active grant(s) for writer(s) claude-user. The connector must re-authorize.",
        );

        // Check active grant table
        expect(html).toContain("claude-user");
        expect(html).toContain(`••••${tokenHash.slice(-4)}`);
        expect(html).toContain("read write");
        expect(html).toContain(`Revoke grant ••••${tokenHash.slice(-4)} for claude-user?`);

        // Unmapped fleet host links to #oauth-access
        expect(html).toContain('<a href="#oauth-access" class="muted">Unmapped</a>');

        // Security: NO secrets or full hash exposed
        expect(html).not.toContain("super-secret-12345");
        expect(html).not.toContain("rt-secret-token-xyz");
        expect(html).not.toContain(tokenHash);
      } finally {
        await ctx.close();
      }
    });

    it("falls back to clientId if clientName is missing", async () => {
      const store = new InMemoryOAuthStore();
      await store.saveClient({
        clientId: "raw-client-id",
        redirectUris: ["http://localhost:3000/callback"],
      });
      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
        const html = await res.text();
        expect(html).toContain("raw-client-id");
        expect(html).toContain(
          "Revoke client raw-client-id? This invalidates 0 active grant(s) for writer(s) none. The connector must re-authorize.",
        );
      } finally {
        await ctx.close();
      }
    });

    it("revokes an active grant on POST /console/oauth/revoke-grant and appends audit row", async () => {
      const store = new InMemoryOAuthStore();
      const tokenHash = hashToken("rt-test-revoke");
      await store.saveRefreshToken({
        tokenHash,
        clientId: "client-abc",
        writerId: "operator-user",
        expiresAt: Date.now() + 86400_000,
      });

      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/revoke-grant`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `token_fingerprint=${encodeURIComponent(`••••${tokenHash.slice(-4)}`)}&confirm=1`,
          redirect: "manual",
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");

        // Grant should be revoked in store
        const remaining = await store.listRefreshTokens();
        expect(remaining).toHaveLength(0);

        // Audit log must contain the revocation row
        const auditContent = readFileSync(ctx.auditFile, "utf8");
        const rows = parseAuditLines(auditContent);
        const revokeRow = rows.find((r) => r.tool === "console.oauth_revoke");
        expect(revokeRow).toBeDefined();
        expect(revokeRow?.host_id).toBe("operator");
        expect(revokeRow?.path).toBe(`oauth-grant:••••${tokenHash.slice(-4)}`);
        expect(revokeRow?.ok).toBe(true);
      } finally {
        await ctx.close();
      }
    });

    it("revokes a client and cascades to all its grants on POST /console/oauth/revoke-client and appends audit row", async () => {
      const store = new InMemoryOAuthStore();
      await store.saveClient({
        clientId: "client-to-revoke",
        clientName: "App To Revoke",
        redirectUris: ["http://localhost/cb"],
      });
      await store.saveClient({
        clientId: "client-to-keep",
        clientName: "App To Keep",
        redirectUris: ["http://localhost/cb"],
      });

      const hash1 = hashToken("tok-1");
      const hash2 = hashToken("tok-2");
      const hashKeep = hashToken("tok-keep");

      await store.saveRefreshToken({
        tokenHash: hash1,
        clientId: "client-to-revoke",
        writerId: "user-1",
        expiresAt: Date.now() + 86400_000,
      });
      await store.saveRefreshToken({
        tokenHash: hash2,
        clientId: "client-to-revoke",
        writerId: "user-2",
        expiresAt: Date.now() + 86400_000,
      });
      await store.saveRefreshToken({
        tokenHash: hashKeep,
        clientId: "client-to-keep",
        writerId: "user-keep",
        expiresAt: Date.now() + 86400_000,
      });

      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/revoke-client`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `client_id=client-to-revoke&confirm=1`,
          redirect: "manual",
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console");

        // client-to-revoke gone, client-to-keep remains
        const clients = await store.listClients();
        expect(clients.map((c) => c.clientId)).toEqual(["client-to-keep"]);

        // grants for revoked client gone, client-to-keep grants remain
        const grants = await store.listRefreshTokens();
        expect(grants.map((g) => g.tokenHash)).toEqual([hashKeep]);

        // Audit row check
        const auditContent = readFileSync(ctx.auditFile, "utf8");
        const rows = parseAuditLines(auditContent);
        const revokeRow = rows.find((r) => r.tool === "console.oauth_revoke");
        expect(revokeRow).toBeDefined();
        expect(revokeRow?.host_id).toBe("operator");
        expect(revokeRow?.path).toBe("oauth-client:client-to-revoke");
        expect(revokeRow?.ok).toBe(true);
      } finally {
        await ctx.close();
      }
    });

    it("appends ok:false audit row when revoking non-existent grant or client", async () => {
      const store = new InMemoryOAuthStore();
      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        // Non-existent grant
        const fakeHash = hashToken("non-existent-grant");
        const res1 = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/revoke-grant`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `token_fingerprint=${encodeURIComponent(`••••${fakeHash.slice(-4)}`)}&confirm=1`,
          redirect: "manual",
        });
        expect(res1.status).toBe(302);

        // Non-existent client
        const res2 = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/revoke-client`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `client_id=fake-client&confirm=1`,
          redirect: "manual",
        });
        expect(res2.status).toBe(302);

        const auditContent = readFileSync(ctx.auditFile, "utf8");
        const rows = parseAuditLines(auditContent).filter((r) => r.tool === "console.oauth_revoke");
        expect(rows).toHaveLength(2);
        expect(rows[0].ok).toBe(false);
        expect(rows[0].path).toBe(`oauth-grant:••••${fakeHash.slice(-4)}`);
        expect(rows[1].ok).toBe(false);
        expect(rows[1].path).toBe("oauth-client:fake-client");
      } finally {
        await ctx.close();
      }
    });

    it("refuses GET requests on OAuth mutation routes with 302 redirect", async () => {
      const store = new InMemoryOAuthStore();
      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        for (const path of ["/console/oauth/revoke-grant", "/console/oauth/revoke-client"]) {
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { redirect: "manual" });
          expect(res.status, path).toBe(302);
          expect(res.headers.get("location"), path).toBe("/console");
        }
      } finally {
        await ctx.close();
      }
    });

    it("does not mutate or audit OAuth routes when the form confirmation is invalid", async () => {
      const store = new InMemoryOAuthStore();
      const tokenHash = hashToken("invalid-confirmation");
      await store.saveRefreshToken({
        tokenHash,
        clientId: "client-abc",
        writerId: "operator-user",
        expiresAt: Date.now() + 86400_000,
      });
      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/revoke-grant`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "confirm=0&token_fingerprint=%E2%80%A2%E2%80%A2%E2%80%A21234",
          redirect: "manual",
        });
        expect(res.status).toBe(302);
        expect(await store.listRefreshTokens()).toHaveLength(1);
        expect(readFileSync(ctx.auditFile, "utf8")).toBe("");
      } finally {
        await ctx.close();
      }
    });

    it("refuses POST to OAuth revoke routes from a public Host header", async () => {
      const store = new InMemoryOAuthStore();
      const ctx = await startConsole({ tokenMapYaml: "", oauthStore: store });
      try {
        for (const path of ["/console/oauth/revoke-grant", "/console/oauth/revoke-client"]) {
          const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = httpRequest(
              {
                host: "127.0.0.1",
                port: ctx.port,
                method: "POST",
                path,
                headers: {
                  Host: "wiki.karldigi.dev",
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Content-Length": Buffer.byteLength("confirm=1"),
                },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
              },
            );
            req.on("error", reject);
            req.end("confirm=1");
          });
          expect(status, path).toBe(404);
          expect(body, path).toContain("not_found");
        }
      } finally {
        await ctx.close();
      }
    });
  });

  describe("Operator login (layout A + set-password)", () => {
    it("renders Operator login section in layout A on GET /console with status Unset when live hash absent", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          stateDir,
        },
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("<h2>Operator login ");
        expect(html).toContain("Unset");
        expect(html).not.toContain("Configured");
        expect(html).toContain('action="/console/oauth/set-password"');
        expect(html).toContain('name="password"');
        expect(html).toContain('name="password_confirm"');
        expect(html).toContain('name="confirm" value="1"');
        expect(html).toContain("Set password");
        expect(html).toContain("Save the same value in the host Keychain. Daemon stores a hash only. Grants stay until OAuth access revoke.");
        expect(html).toContain('<a href="/console/operator-login">');
      } finally {
        await ctx.close();
      }
    });

    it("renders Operator login section in layout A on GET /console with status Configured when live hash present", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const dummyHash = "scrypt$16384$8$1$c2FsdA$urlsafe$aGFzaA";
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          passwordHash: dummyHash,
          stateDir,
        },
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console`);
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("<h2>Operator login ");
        expect(html).toContain("Configured");
        expect(html).not.toContain(dummyHash);
      } finally {
        await ctx.close();
      }
    });

    it("keeps the header nav identical on /console and /console/operator-login", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          stateDir,
        },
      });
      try {
        for (const path of ["/console", "/console/operator-login"]) {
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`);
          expect(res.status, path).toBe(200);
          const html = await res.text();
          expect(html, path).toContain('href="/console"');
          expect(html, path).toContain('href="/console/operator-login"');
          expect(html, path).toContain('aria-current="page"');
        }
      } finally {
        await ctx.close();
      }
    });

    it("serves 200 HTML on GET /console/operator-login and /console/operator-login/", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          stateDir,
        },
      });
      try {
        for (const path of ["/console/operator-login", "/console/operator-login/"]) {
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`);
          expect(res.status, path).toBe(200);
          expect(res.headers.get("content-type")).toMatch(/text\/html/);
          const html = await res.text();
          expect(html).toContain("<h2>Operator login ");
          expect(html).toContain("Unset");
          expect(html).toContain('action="/console/oauth/set-password"');
          expect(html).toContain('name="password"');
          expect(html).toContain('name="password_confirm"');
          expect(html).toContain('name="confirm" value="1"');
          expect(html).toContain("Set password");
          expect(html).toContain("Save the same value in the host Keychain. Daemon stores a hash only. Grants stay until OAuth access revoke.");
        }
      } finally {
        await ctx.close();
      }
    });

    it("redirects GET /console/oauth/set-password with 302 to /console/operator-login", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          stateDir,
        },
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/set-password`, {
          redirect: "manual",
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe("/console/operator-login");
      } finally {
        await ctx.close();
      }
    });

    it("POST /console/oauth/set-password sets password, persists file, updates live hash, records audit", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          stateDir,
        },
      });
      try {
        const body = new URLSearchParams({
          password: "my-operator-secret",
          password_confirm: "my-operator-secret",
          confirm: "1",
        }).toString();

        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/set-password`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("Password set.");
        expect(html).toContain("Configured");
        expect(html).not.toContain("my-operator-secret");

        // Verify file persisted
        const savedHash = readFileSync(join(stateDir, "password.hash"), "utf8").trim();
        expect(savedHash).toMatch(/^scrypt\$/);
        expect(html).not.toContain(savedHash);

        // Verify live hash updated on oauthConfig
        expect(ctx.oauthConfig?.passwordHash).toBe(savedHash);

        // Verify audit log
        const auditContent = readFileSync(ctx.auditFile, "utf8");
        const auditRows = auditContent.trim().split("\n").map((l) => JSON.parse(l));
        const setRow = auditRows.find((r) => r.tool === "console.oauth_set_password");
        expect(setRow).toBeDefined();
        expect(setRow.host_id).toBe("operator");
        expect(setRow.ok).toBe(true);
        expect(setRow.ms).toBeGreaterThanOrEqual(0);
        // No secrets in audit
        expect(JSON.stringify(setRow)).not.toContain("my-operator-secret");
        expect(JSON.stringify(setRow)).not.toContain(savedHash);

        // Verify authorize now works with new password without server restart
        const authRes = await fetch(`http://127.0.0.1:${ctx.port}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: "test-client",
            password: "my-operator-secret",
            response_type: "code",
            redirect_uri: "http://localhost/cb",
          }).toString(),
          redirect: "manual",
        });
        // Non-empty password verified! If password was wrong it would be 401
        expect(authRes.status).not.toBe(401);
      } finally {
        await ctx.close();
      }
    });

    it("refuses 400 and leaves file and live hash unchanged on validation failures", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const initialHash = "scrypt$16384$8$1$c2FsdA$urlsafe$aW5pdGlhbA";
      await writeFile(join(stateDir, "password.hash"), `${initialHash}\n`, "utf8");

      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          passwordHash: initialHash,
          stateDir,
        },
      });
      try {
        const testCases = [
          // empty password
          { body: "password=&password_confirm=&confirm=1" },
          // whitespace-only
          { body: "password=   &password_confirm=   &confirm=1" },
          // mismatch
          { body: "password=abc&password_confirm=def&confirm=1" },
          // missing confirm=1
          { body: "password=abc&password_confirm=abc" },
          { body: "password=abc&password_confirm=abc&confirm=0" },
          // query confirm=1 without body confirm
          { path: "/console/oauth/set-password?confirm=1", body: "password=abc&password_confirm=abc" },
        ];

        for (const tc of testCases) {
          const path = tc.path ?? "/console/oauth/set-password";
          const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tc.body,
          });
          expect(res.status, JSON.stringify(tc)).toBe(400);

          // File unchanged
          expect(readFileSync(join(stateDir, "password.hash"), "utf8").trim()).toBe(initialHash);
          // Live hash unchanged
          expect(ctx.oauthConfig?.passwordHash).toBe(initialHash);
        }
      } finally {
        await ctx.close();
      }
    });

    it("refuses 400 when stateDir is missing (injected store without stateDir)", async () => {
      const store = new InMemoryOAuthStore();
      const initialHash = "scrypt$16384$8$1$c2FsdA$urlsafe$aW5pdGlhbA";
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          passwordHash: initialHash,
          store,
          // no stateDir
        },
      });
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/console/oauth/set-password`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "password=newsecret&password_confirm=newsecret&confirm=1",
        });
        expect(res.status).toBe(400);
        expect(ctx.oauthConfig?.passwordHash).toBe(initialHash);
      } finally {
        await ctx.close();
      }
    });

    it("returns 404 from public Host header on GET /console/operator-login and POST/GET /console/oauth/set-password", async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "sw-state-"));
      const ctx = await startConsole({
        tokenMapYaml: "",
        oauth: {
          enabled: true,
          stateDir,
        },
      });
      try {
        const paths = [
          { method: "GET", path: "/console/operator-login" },
          { method: "GET", path: "/console/oauth/set-password" },
          { method: "POST", path: "/console/oauth/set-password", body: "confirm=1" },
        ];

        for (const tc of paths) {
          const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = httpRequest(
              {
                host: "127.0.0.1",
                port: ctx.port,
                method: tc.method,
                path: tc.path,
                headers: {
                  Host: "wiki.karldigi.dev",
                  ...(tc.body
                    ? {
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Content-Length": Buffer.byteLength(tc.body),
                      }
                    : {}),
                },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
              },
            );
            req.on("error", reject);
            if (tc.body) req.write(tc.body);
            req.end();
          });
          expect(status, `${tc.method} ${tc.path}`).toBe(404);
          expect(body, `${tc.method} ${tc.path}`).toContain("not_found");
        }
      } finally {
        await ctx.close();
      }
    });
  });
});
