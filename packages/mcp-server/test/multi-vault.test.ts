import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTokenMap } from "../src/auth.js";
import { isAllowedWritePath } from "../src/allowlist.js";
import { ChangedEventHub } from "../src/events.js";
import { InMemoryOAuthStore } from "../src/oauth-store.js";
import { ReconcileGate } from "../src/reconcile.js";
import { startMcpHttpServer } from "../src/server.js";
import { commitWrite, withWriteMutex } from "../src/txn.js";
import { buildVaultRegistry } from "../src/vault-registry.js";
import type { VaultRuntime } from "../src/vault-runtime.js";
import { makeS3Store, makeTempVault } from "./helpers.js";

const TOOLS = [
  "wiki_query",
  "wiki_read_page",
  "wiki_memory_recall",
  "wiki_status",
  "wiki_context",
  "wiki_sources_pending",
  "wiki_compile_status",
  "wiki_reviews",
  "wiki_lint_summary",
  "wiki_stale",
  "wiki_capture",
  "wiki_log_append",
  "wiki_workitem_write",
  "wiki_page_publish",
] as const;

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
}

async function callTool(
  port: number,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function structured(body: Record<string, unknown>): Record<string, unknown> {
  const result = body.result as { structuredContent?: Record<string, unknown> } | undefined;
  return result?.structuredContent ?? {};
}

async function setupDualVault(opts?: { extraEnabled?: boolean; extraReady?: boolean; grants?: string[] }) {
  const central = await makeTempVault();
  const extra = await makeTempVault();
  await mkdir(join(extra, "projects", "finance"), { recursive: true });
  const centralPage = `---
title: Shared
created: 2026-09-18
updated: 2026-09-18
type: concept
tags: []
sources: []
---
central body
`;
  const extraPage = `---
title: Shared
created: 2026-09-18
updated: 2026-09-18
type: concept
tags: []
sources: []
---
wiki-fin body
`;
  await writeFile(join(central, "concepts", "shared.md"), centralPage, "utf8");
  await writeFile(join(extra, "concepts", "shared.md"), extraPage, "utf8");
  const centralS3 = makeS3Store({
    "concepts/shared.md": centralPage,
    "log.md": await readFile(join(central, "log.md"), "utf8"),
  });
  const extraS3 = makeS3Store({
    "concepts/shared.md": extraPage,
    "log.md": await readFile(join(extra, "log.md"), "utf8"),
  });

  const registry = buildVaultRegistry([
    {
      vaultId: "central",
      isDefault: true,
      localRoot: central,
      rcloneRemote: "seaweed-wiki",
      rclonePath: "cloud/wiki",
      s3Bucket: "cloud",
      s3Prefix: "wiki",
    },
    {
      vaultId: "wiki-fin",
      enabled: opts?.extraEnabled !== false,
      localRoot: extra,
      rcloneRemote: "seaweed-wiki",
      rclonePath: "cloud/wiki-fin",
      s3Bucket: "cloud",
      s3Prefix: "wiki-fin",
      snapshotAuthority: "sg01-wiki-fin-snapshot",
      projectionAuthority: "sg01-wiki-fin-snapshot",
    },
  ]);

  const centralGate = new ReconcileGate(async () => undefined);
  const extraGate = new ReconcileGate(
    opts?.extraReady === false
      ? async () => {
          throw new Error("wiki-fin rclone timeout");
        }
      : async () => undefined,
  );
  await centralGate.runFirst();
  if (opts?.extraReady !== false) {
    await extraGate.runFirst().catch(() => undefined);
  } else {
    await extraGate.runFirst().catch(() => undefined);
  }

  const runtimes = new Map<string, VaultRuntime>([
    [
      "central",
      {
        entry: registry.entries.get("central")!,
        gate: centralGate,
        putObject: centralS3.putObject,
        getObject: centralS3.getObject,
      },
    ],
    [
      "wiki-fin",
      {
        entry: registry.entries.get("wiki-fin")!,
        gate: extraGate,
        putObject: extraS3.putObject,
        getObject: extraS3.getObject,
      },
    ],
  ]);

  const token = "test-token";
  const hash = createHash("sha256").update(token, "utf8").digest("hex");
  const grants = opts?.grants ?? ["central", "wiki-fin"];
  const tokenMap = parseTokenMap(
    `${hash}:\n  writer_id: macos-dev\n  allowed_vaults: [${grants.join(", ")}]\n`,
  );
  const hub = new ChangedEventHub({ pingMs: 0 });
  const server = await startMcpHttpServer({
    bind: "127.0.0.1",
    port: 0,
    vaultDir: central,
    tokenMap,
    gate: centralGate,
    putObject: centralS3.putObject,
    getObject: centralS3.getObject,
    hub,
    registry,
    runtimes,
    auditFile: join(central, "audit.jsonl"),
  });
  const { port } = server.address() as AddressInfo;
  return {
    central,
    extra,
    centralS3,
    extraS3,
    centralGate,
    extraGate,
    token,
    port,
    hub,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("multi-vault HTTP MCP slices 1-5", () => {
  it("omitted vault on every tool stays on central", async () => {
    const ctx = await setupDualVault();
    try {
      const argsByTool: Record<string, Record<string, unknown>> = {
        wiki_query: { query: "alpha" },
        wiki_read_page: { path: "concepts/shared.md" },
        wiki_memory_recall: { project: "llm-wiki", topic: "agent-memory" },
        wiki_status: {},
        wiki_context: {},
        wiki_sources_pending: {},
        wiki_compile_status: {},
        wiki_reviews: {},
        wiki_lint_summary: {},
        wiki_stale: {},
        wiki_capture: { kind: "note", project: "llm-wiki", title: "omit vault", content: "central capture" },
        wiki_log_append: { content: "omit-vault log" },
        wiki_workitem_write: {
          path: "projects/llm-wiki/work/2026-09-18-omit/spec.md",
          content: "---\ntitle: omit\nstatus: planned\n---\n# omit\n",
        },
        wiki_page_publish: {
          path: "concepts/omit-page.md",
          content: "---\ntitle: omit\ncreated: 2026-09-18\nupdated: 2026-09-18\ntype: concept\ntags: []\nsources: []\n---\nbody\n",
        },
      };
      expect(TOOLS).toHaveLength(14);
      for (const name of TOOLS) {
        const { status, body } = await callTool(ctx.port, ctx.token, name, argsByTool[name]!);
        expect(status, name).toBe(200);
        const sc = structured(body);
        expect(String(sc.error ?? ""), name).not.toMatch(/VAULT_/);
        if (name === "wiki_read_page") {
          expect(sc.markdown).toContain("central body");
        }
        if (name === "wiki_context") {
          expect(sc.default_vault).toBe("central");
          expect(sc.vault_id).toBe("central");
        }
      }
      expect(ctx.extraS3.store.has("concepts/omit-page.md")).toBe(false);
      expect(ctx.centralS3.store.has("concepts/omit-page.md")).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("unauthorized, unknown, and disabled vaults fail closed with zero storage side effects", async () => {
    const unauthorized = await setupDualVault({ grants: ["central"] });
    try {
      const beforeCentral = ctxSnapshot(unauthorized.centralS3.store);
      const beforeExtra = ctxSnapshot(unauthorized.extraS3.store);
      for (const vault of ["wiki-fin", "no-such", "*", "Central"]) {
        const { status, body } = await callTool(unauthorized.port, unauthorized.token, "wiki_read_page", {
          path: "concepts/shared.md",
          vault,
        });
        expect(status).toBe(200);
        const sc = structured(body);
        expect(sc.ok).toBe(false);
        expect(String(sc.error)).toMatch(/^VAULT_/);
        expect(sc.markdown).toBeUndefined();
      }
      const { body: writeBody } = await callTool(unauthorized.port, unauthorized.token, "wiki_page_publish", {
        path: "concepts/should-not.md",
        content: "nope\n",
        vault: "wiki-fin",
      });
      expect(structured(writeBody).ok).toBe(false);
      expect(ctxSnapshot(unauthorized.centralS3.store)).toEqual(beforeCentral);
      expect(ctxSnapshot(unauthorized.extraS3.store)).toEqual(beforeExtra);
    } finally {
      await unauthorized.close();
    }

    const disabled = await setupDualVault({ extraEnabled: false });
    try {
      const before = ctxSnapshot(disabled.extraS3.store);
      const { body } = await callTool(disabled.port, disabled.token, "wiki_read_page", {
        path: "concepts/shared.md",
        vault: "wiki-fin",
      });
      expect(structured(body)).toMatchObject({ ok: false, error: "VAULT_DISABLED" });
      expect(ctxSnapshot(disabled.extraS3.store)).toEqual(before);
    } finally {
      await disabled.close();
    }
  });

  it("same relative path is isolated across two fixture vaults for read, CAS, capture, audit, and events", async () => {
    const ctx = await setupDualVault();
    const events: string[] = [];
    try {
      const fakeRes = {
        writeHead() {},
        write(chunk: string | Buffer) {
          events.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        },
        end() {},
        on() {
          return this;
        },
      } as unknown as import("node:http").ServerResponse;
      ctx.hub.subscribe(fakeRes, { allowedVaults: ["central"] });

      const centralRead = structured(
        (await callTool(ctx.port, ctx.token, "wiki_read_page", { path: "concepts/shared.md" })).body,
      );
      const extraRead = structured(
        (
          await callTool(ctx.port, ctx.token, "wiki_read_page", {
            path: "concepts/shared.md",
            vault: "wiki-fin",
          })
        ).body,
      );
      expect(centralRead.markdown).toContain("central body");
      expect(extraRead.markdown).toContain("wiki-fin body");
      expect(centralRead.sha256).not.toBe(extraRead.sha256);

      const extraWrite = structured(
        (
          await callTool(ctx.port, ctx.token, "wiki_page_publish", {
            vault: "wiki-fin",
            path: "concepts/shared.md",
            content: `---
title: Shared
created: 2026-09-18
updated: 2026-09-18
type: concept
tags: []
sources: []
---
wiki-fin updated
`,
            base_sha256: extraRead.sha256,
          })
        ).body,
      );
      expect(extraWrite.ok).toBe(true);
      const centralAfter = await readFile(join(ctx.central, "concepts", "shared.md"), "utf8");
      expect(centralAfter).toContain("central body");
      expect(await readFile(join(ctx.extra, "concepts", "shared.md"), "utf8")).toContain("wiki-fin updated");

      const capture = structured(
        (
          await callTool(ctx.port, ctx.token, "wiki_capture", {
            vault: "wiki-fin",
            kind: "note",
            project: "finance",
            title: "isolated",
            content: "fin note",
          })
        ).body,
      );
      expect(capture.ok).toBe(true);
      expect(ctx.centralS3.store.has(String(capture.path))).toBe(false);
      expect(ctx.extraS3.store.has(String(capture.path))).toBe(true);

      const audit = await readFile(join(ctx.central, "audit.jsonl"), "utf8");
      expect(audit).toContain('"vault_id":"wiki-fin"');

      expect(events.join("")).not.toContain("wiki-fin");
      ctx.hub.emitChanged(["concepts/shared.md"], "wiki-fin");
      expect(events.join("")).not.toContain("wiki-fin");
      ctx.hub.emitChanged(["concepts/shared.md"], "central");
      expect(events.join("")).toContain('"vault_id":"central"');
    } finally {
      await ctx.close();
    }
  });

  it("reconcile/readiness is independent per vault", async () => {
    const ctx = await setupDualVault({ extraReady: false });
    try {
      expect(ctx.centralGate.ready).toBe(true);
      expect(ctx.extraGate.ready).toBe(false);
      expect(ctx.extraGate.lastError).toMatch(/wiki-fin rclone timeout/);
      const centralStatus = structured((await callTool(ctx.port, ctx.token, "wiki_status", {})).body);
      expect(centralStatus.ok).toBe(true);
      expect(centralStatus.reconcile_ready).toBe(true);
      const extraStatus = structured(
        (await callTool(ctx.port, ctx.token, "wiki_status", { vault: "wiki-fin" })).body,
      );
      expect(extraStatus.ok).toBe(false);
      expect(extraStatus.error).toBe("TOOLS_NOT_READY");
    } finally {
      await ctx.close();
    }
  });

  it("OAuth writer allowed_vaults is enforced the same as host tokens", async () => {
    const central = await makeTempVault();
    const extra = await makeTempVault();
    const registry = buildVaultRegistry([
      {
        vaultId: "central",
        isDefault: true,
        localRoot: central,
        rcloneRemote: "seaweed-wiki",
        rclonePath: "cloud/wiki",
        s3Bucket: "cloud",
        s3Prefix: "wiki",
      },
      {
        vaultId: "wiki-fin",
        localRoot: extra,
        rcloneRemote: "seaweed-wiki",
        rclonePath: "cloud/wiki-fin",
        s3Bucket: "cloud",
        s3Prefix: "wiki-fin",
      },
    ]);
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const extraGate = new ReconcileGate(async () => undefined);
    await extraGate.runFirst();
    const store = new InMemoryOAuthStore();
    const access = "oauth-central-only";
    await store.saveAccessToken({
      tokenHash: createHash("sha256").update(access, "utf8").digest("hex"),
      clientId: "chatgpt",
      writerId: "chatgpt-web",
      expiresAt: Date.now() + 60_000,
    });
    const server = await startMcpHttpServer({
      bind: "127.0.0.1",
      port: 0,
      vaultDir: central,
      tokenMap: new Map(),
      gate,
      putObject: async () => undefined,
      registry,
      runtimes: new Map([
        ["central", { entry: registry.entries.get("central")!, gate, putObject: async () => undefined }],
        ["wiki-fin", { entry: registry.entries.get("wiki-fin")!, gate: extraGate, putObject: async () => undefined }],
      ]),
      oauth: {
        enabled: true,
        store,
        writers: [{ writer_id: "chatgpt-web", allowed_vaults: ["central"] }],
      },
    });
    const { port } = server.address() as AddressInfo;
    try {
      const denied = structured(
        (await callTool(port, access, "wiki_read_page", { path: "concepts/alpha.md", vault: "wiki-fin" })).body,
      );
      expect(denied).toMatchObject({ ok: false, error: "VAULT_UNAUTHORIZED" });
      const allowed = structured((await callTool(port, access, "wiki_context", {})).body);
      expect(allowed.ok).toBe(true);
      expect(allowed.default_vault).toBe("central");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("client SKILLWIKI_EXTRA_VAULTS is not a server authorization bypass", async () => {
    const previous = process.env.SKILLWIKI_EXTRA_VAULTS;
    process.env.SKILLWIKI_EXTRA_VAULTS = "wiki-fin";
    try {
      const ctx = await setupDualVault({ grants: ["central"] });
      try {
        const sc = structured(
          (
            await callTool(ctx.port, ctx.token, "wiki_read_page", {
              path: "concepts/shared.md",
              vault: "wiki-fin",
            })
          ).body,
        );
        expect(sc).toMatchObject({ ok: false, error: "VAULT_UNAUTHORIZED" });
      } finally {
        await ctx.close();
      }
    } finally {
      if (previous === undefined) delete process.env.SKILLWIKI_EXTRA_VAULTS;
      else process.env.SKILLWIKI_EXTRA_VAULTS = previous;
    }
  });

  it("keeps D11 mutations denied on extra vaults and D7 jobs out of the MCP process", async () => {
    expect(isAllowedWritePath("projects/llm-wiki/history/x.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/fleet.yaml", "workitem")).toBe(false);
    const ctx = await setupDualVault();
    try {
      const denied = structured(
        (
          await callTool(ctx.port, ctx.token, "wiki_workitem_write", {
            vault: "wiki-fin",
            path: "projects/finance/history/old.md",
            content: "no\n",
          })
        ).body,
      );
      expect(denied.error).toBe("PATH_DENIED");
    } finally {
      await ctx.close();
    }
  });
});

describe("per-vault write mutex", () => {
  it("allows two vaults to proceed independently while serializing within a vault", async () => {
    let inflight = 0;
    let maxInflight = 0;
    await Promise.all([
      withWriteMutex(async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight -= 1;
      }, "central"),
      withWriteMutex(async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 30));
        inflight -= 1;
      }, "wiki-fin"),
    ]);
    expect(maxInflight).toBe(2);

    const vault = await makeTempVault();
    await commitWrite(
      { vaultDir: vault, vaultId: "wiki-fin", putObject: async () => undefined },
      [{ relPath: "raw/transcripts/2026-09-18-note-mutex.md", content: "ok\n" }],
    );
    expect(await readFile(join(vault, "raw/transcripts/2026-09-18-note-mutex.md"), "utf8")).toBe("ok\n");
  });
});

function ctxSnapshot(store: Map<string, Buffer>): string[] {
  return [...store.keys()].sort();
}
