import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runConnect } from "../../src/commands/connect.js";

const PLANTED = "planted-mcp-connect-7c1e4a90b2d85f31";
const OTHER = "planted-mcp-connect-other-1f8c3d62a0b947e5";
const HOST = "unknown-agent-fixture";

function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), "connect-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

function envFile(dir: string, body: string): string {
  const p = join(dir, "chat-attachment.env");
  writeFileSync(p, body);
  return p;
}

function fixtureEnv(token = PLANTED, host = HOST): string {
  return [
    `SKILLWIKI_MCP_URL=https://wiki.karldigi.dev/mcp`,
    `SKILLWIKI_HOST_ID=${host}`,
    `SKILLWIKI_MCP_TOKEN=${token}`,
    "",
  ].join("\n");
}

function fakeMcpFetch(): typeof fetch {
  return (async (_input, init) => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const parsed = JSON.parse(raw) as { id?: unknown; method?: string; params?: { name?: string } };
    if (parsed.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "skillwiki-mcp", version: "0.10.98" },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.method === "tools/list") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: {
          tools: [
            "wiki_query", "wiki_memory_recall", "wiki_read_page", "wiki_status",
            "wiki_capture", "wiki_log_append", "wiki_page_publish", "wiki_workitem_write",
          ].map((name) => ({ name })),
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.method === "tools/call" && parsed.params?.name === "wiki_status") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        result: {
          structuredContent: {
            writer_id: HOST,
            ok: true,
            reconcile_ready: true,
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
}

function assertNoSecret(payload: unknown): void {
  const dumped = JSON.stringify(payload);
  expect(dumped).not.toContain(PLANTED);
  expect(dumped).not.toContain(OTHER);
}

describe("skillwiki connect", () => {
  it("dry-run validates without writing ~/.skillwiki/.env", async () => {
    const home = tmpHome();
    const dest = join(home, ".skillwiki", ".env");
    const fromFile = envFile(home, fixtureEnv());
    const r = await runConnect({
      home,
      fromFile,
      dryRun: true,
      checkMcp: false,
      currentVersion: "0.10.98",
      env: {},
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    expect(r.result.data.dry_run).toBe(true);
    expect(r.result.data.written).toBe(false);
    expect(r.result.data.token).toBe("TOKEN_SET");
    expect(r.result.data.auth).toBe("present");
    expect(existsSync(dest)).toBe(false);
    assertNoSecret(r.result);
    expect(r.result.data.humanHint).not.toContain(PLANTED);
  });

  it("writes 0600 env and reports TOKEN_SET without echoing the secret", async () => {
    const home = tmpHome();
    const dest = join(home, ".skillwiki", ".env");
    const fromFile = envFile(home, fixtureEnv());
    const r = await runConnect({
      home,
      fromFile,
      checkMcp: true,
      currentVersion: "0.10.98",
      env: {},
      mcpFetch: fakeMcpFetch(),
    });
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    expect(r.result.data.written).toBe(true);
    expect(r.result.data.token).toBe("TOKEN_SET");
    expect(r.result.data.writer_id).toBe(HOST);
    expect(r.result.data.ok).toBe(true);
    expect(r.result.data.reconcile_ready).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readFileSync(dest, "utf8")).toContain(`SKILLWIKI_MCP_TOKEN=${PLANTED}`);
    assertNoSecret(r.result);
  });

  it("refuses Drive / 云盘 as the secret path", async () => {
    const home = tmpHome();
    const r = await runConnect({
      home,
      fromFile: "/Users/x/Library/CloudStorage/GoogleDrive-x/secret.env",
      dryRun: true,
      checkMcp: false,
      currentVersion: "0.10.98",
      env: {},
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe("DRIVE_UNSUPPORTED");
    assertNoSecret(r.result);
  });

  it("refuses reserved host-ids", async () => {
    const home = tmpHome();
    const fromFile = envFile(home, fixtureEnv(PLANTED, "macos-dev"));
    const r = await runConnect({
      home,
      fromFile,
      dryRun: true,
      checkMcp: false,
      currentVersion: "0.10.98",
      env: {},
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe("RESERVED_HOST_ID");
    assertNoSecret(r.result);
  });

  it("refuses overwrite of a different token without --force", async () => {
    const home = tmpHome();
    writeFileSync(join(home, ".skillwiki", ".env"), fixtureEnv(OTHER));
    const fromFile = envFile(home, fixtureEnv(PLANTED));
    const r = await runConnect({
      home,
      fromFile,
      dryRun: true,
      checkMcp: false,
      currentVersion: "0.10.98",
      env: {},
    });
    expect(r.exitCode).toBe(ExitCode.ENV_WRITE_CONFLICT);
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe("ENV_WRITE_CONFLICT");
    assertNoSecret(r.result);
  });

  it("refuses vault-init looking sources", async () => {
    const home = tmpHome();
    const fromFile = envFile(home, "# Vault Schema\n\n## Tag Taxonomy\n");
    const r = await runConnect({
      home,
      fromFile,
      dryRun: true,
      checkMcp: false,
      currentVersion: "0.10.98",
      env: {},
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (r.result.ok) return;
    expect(r.result.error).toBe("REFUSE_INIT");
  });

  it("reads stdin without echoing", async () => {
    const home = tmpHome();
    const r = await runConnect({
      home,
      fromStdin: true,
      dryRun: true,
      checkMcp: false,
      currentVersion: "0.10.98",
      env: {},
      readStdin: async () => fixtureEnv(),
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    expect(r.result.data.token).toBe("TOKEN_SET");
    assertNoSecret(r.result);
  });
});
