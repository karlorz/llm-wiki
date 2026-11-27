import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { frozenVaultWriteRefusal } from "../../src/utils/frozen-vault-write.js";
import { join } from "node:path";
import { ok, ExitCode } from "@skillwiki/shared";
import { runIngest } from "../../src/commands/ingest.js";
import { defaultPagePublishDeps, preparePagePublicationFromContent, publishPreparedPageWithReceipt, runPagePublish } from "../../src/commands/page-publish.js";
import { runManagedWritePreflight, runManagedWriteTransaction, type ManagedWriteReceipt } from "../../src/utils/managed-write-preflight.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpMutatingTools } from "../../src/mcp/mutating-tools.js";
import { postCommit } from "../../src/utils/auto-commit.js";
import { runWritePreflightCommand } from "../../src/commands/write-preflight.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(frozen = true) {
  const root = mkdtempSync(join(tmpdir(), "frozen-write-"));
  roots.push(root);
  const vault = join(root, "vault");
  mkdirSync(vault);
  mkdirSync(join(vault, "queries"));
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n\n## Tag Taxonomy\n\n```yaml\ntaxonomy:\n  - research\n```\n");
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Queries\n");
  writeFileSync(join(vault, "log.md"), "# Log\n");
  if (frozen) writeFileSync(join(vault, ".WIKI_GIT_FROZEN"), "frozen-leaf/v1\n");
  const draft = join(root, "draft.md");
  const content = "---\ntitle: Frozen test\ncreated: 2026-07-13\nupdated: 2026-07-13\ntype: query\ntags: [research]\nsources: [raw/articles/source.md]\nconfidence: medium\n---\n\n# Frozen test\n\n## Sources\n\n^[raw/articles/source.md]\n";
  writeFileSync(draft, content);
  return { root, vault, draft, content };
}

function snapshot(root: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result[entry.name + "/"] = null;
      for (const [key, value] of Object.entries(snapshot(path))) result[entry.name + "/" + key] = value;
    } else result[entry.name] = readFileSync(path).toString("base64");
  }
  return result;
}

function receipt(vault: string): ManagedWriteReceipt {
  return { mode: "standalone", mutation_vault: vault, git_vault: null, base_oid: null, converged: false, convergence_source: "single-path" };
}

function expectBlocked(run: { exitCode: number; result: unknown }) {
  expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
  expect(run.result).toMatchObject({ ok: false, error: "PREFLIGHT_FAILED", detail: { reason: "frozen-leaf", guidance: expect.stringContaining("HTTP MCP") } });
}

describe("frozen vault local write boundary", () => {
  it("rejects preflight before fleet convergence and leaves every byte unchanged", async () => {
    const { vault } = fixture();
    const before = snapshot(vault);
    const converge = vi.fn();
    expectBlocked(await runManagedWritePreflight({ vault, command: "page publish" }, { converge }));
    expect(converge).not.toHaveBeenCalled();
    expect(snapshot(vault)).toEqual(before);
  });

  it("rejects a transaction before lock creation or an injected preflight", async () => {
    const { vault } = fixture();
    const before = snapshot(vault);
    const preflight = vi.fn(async () => ({ exitCode: 0, result: ok(receipt(vault)) }));
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ changed: true }) }));
    expectBlocked(await runManagedWriteTransaction({ vault, command: "page publish", allowImmutableRecord: true, preflight, mutate }));
    expect(preflight).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(snapshot(vault)).toEqual(before);
  });

  it("rejects ingest before fetching or creating a missing target directory", async () => {
    const { vault } = fixture();
    const before = snapshot(vault);
    const fetch = vi.spyOn(globalThis, "fetch");
    expectBlocked(await runIngest({ source: "https://example.com/research", vault, type: "concept", title: "Frozen test" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(snapshot(vault)).toEqual(before);
  });

  it("rejects file-based publication through a symlink vault alias", async () => {
    const { root, vault, draft } = fixture();
    const alias = join(root, "alias");
    symlinkSync(vault, alias, "dir");
    const before = snapshot(vault);
    expectBlocked(await runPagePublish({ vault: alias, draftPath: draft, target: "queries/frozen.md", write: true }));
    expect(snapshot(vault)).toEqual(before);
  });

  it("rejects a prepared publication even with a supplied write receipt", async () => {
    const { vault, content } = fixture();
    const prepared = preparePagePublicationFromContent({ vault, content, target: "queries/frozen.md" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const before = snapshot(vault);
    const afterStage = vi.fn(async () => undefined);
    expectBlocked(await publishPreparedPageWithReceipt(prepared.data, vault, receipt(vault), defaultPagePublishDeps({ afterStage })));
    expect(afterStage).not.toHaveBeenCalled();
    expect(snapshot(vault)).toEqual(before);
  });

  it("keeps page and ingest dry-runs read-only on a frozen mirror", async () => {
    const { vault, draft } = fixture();
    const before = snapshot(vault);
    const page = await runPagePublish({ vault, draftPath: draft, target: "queries/frozen.md", write: false });
    expect(page.result.ok).toBe(true);
    const ingest = await runIngest({ source: draft, vault, type: "query", title: "Preview", dryRun: true });
    expect(ingest.result.ok).toBe(true);
    expect(snapshot(vault)).toEqual(before);
  });

  it("treats a dangling marker symlink as frozen", () => {
    const { vault, root } = fixture(false);
    symlinkSync(join(root, "missing-marker"), join(vault, ".WIKI_GIT_FROZEN"));
    expectBlocked(frozenVaultWriteRefusal(vault, "ingest")!);
  });

  it("rechecks a marker introduced by an injected preflight", async () => {
    const { vault } = fixture(false);
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ changed: true }) }));
    const run = await runManagedWriteTransaction({
      vault, command: "page publish", allowImmutableRecord: true, mutate,
      preflight: async () => {
        writeFileSync(join(vault, ".WIKI_GIT_FROZEN"), "frozen-leaf/v1\n");
        return { exitCode: 0, result: ok(receipt(vault)) };
      },
    }, {
      converge: vi.fn(),
      syncPeers: () => ({ exitCode: 0, result: ok({ locks: [], stashes: [], stash_audit: [], managed_writers: { count: 0, kinds: [], blocking: false }, blocking: false, humanHint: "no peers" }) }),
    });
    expectBlocked(run);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects built CLI writes even when the dirty gate is bypassed", () => {
    const { vault, draft } = fixture();
    const before = snapshot(vault);
    const bin = join(__dirname, "../../dist/cli.js");
    const commands = [
      ["page", "publish", draft, vault, "--target", "queries/frozen.md", "--write"],
      ["ingest", draft, "--vault", vault, "--type", "concept", "--title", "Frozen test"],
      ["log-append", vault, "--content", "blocked append"],
    ];
    for (const args of commands) {
      const run = spawnSync(process.execPath, [bin, ...args], {
        encoding: "utf8", env: { ...process.env, SKILLWIKI_SKIP_DIRTY_GATE: "1" }, timeout: 10_000,
      });
      expect(run.status, run.stderr || run.stdout).toBe(ExitCode.PREFLIGHT_FAILED);
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, detail: { reason: "frozen-leaf" } });
      expect(snapshot(vault)).toEqual(before);
    }
  });

  it("rejects nested roots and aliases into a frozen mirror", () => {
    const { vault, root } = fixture();
    const nested = join(vault, "queries");
    const alias = join(root, "nested-alias");
    symlinkSync(nested, alias, "dir");
    for (const path of [nested, alias, join(nested, "missing"), join(alias, "missing")]) {
      expectBlocked(frozenVaultWriteRefusal(path, "observe")!);
    }
  });

  it("fails closed when a marker cannot be inspected", () => {
    const { draft } = fixture(false);
    expect(frozenVaultWriteRefusal(draft, "observe")).toMatchObject({
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: { detail: { reason: "frozen-marker-unreadable" } },
    });
  });

  it("reports frozen refusal from the agent-facing write preflight", async () => {
    const { vault } = fixture();
    expectBlocked(await runWritePreflightCommand({ vault, checks: "all", skipDirty: true }));
  });

  it("preserves Git and old operation records during auto-commit and CLI preview", async () => {
    const { vault, draft } = fixture();
    const git = (...args: string[]) => execFileSync("git", ["-C", vault, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("add", ".");
    git("commit", "-m", "fixture");
    mkdirSync(join(vault, ".skillwiki"));
    writeFileSync(join(vault, ".skillwiki", "last-op.json"), JSON.stringify([
      { operation: "observe", summary: "old record", files: ["index.md"], timestamp: new Date().toISOString() },
    ]));
    writeFileSync(join(vault, "index.md"), "# Dirty index\n");
    const before = snapshot(vault);
    const head = git("rev-parse", "HEAD");
    const index = git("diff", "--cached");
    await postCommit(vault, 0);
    const run = spawnSync(process.execPath, [join(__dirname, "../../dist/cli.js"),
      "ingest", draft, "--vault", vault, "--type", "query", "--title", "Preview", "--dry-run"], {
      encoding: "utf8", env: { ...process.env, AUTO_COMMIT: "true" }, timeout: 10_000,
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("diff", "--cached")).toBe(index);
    expect(snapshot(vault)).toEqual(before);
  });

  it("rejects the opted-in local stdio capture tool on a frozen mirror", async () => {
    const { vault } = fixture();
    const before = snapshot(vault);
    vi.stubEnv("SKILLWIKI_MCP_ALLOW_MUTATIONS", "true");
    vi.stubEnv("SKILLWIKI_MCP_AUDIT", "false");
    vi.stubEnv("SKILLWIKI_MCP_VAULT_ALLOWLIST", realpathSync(vault));
    const registerTool = vi.fn();
    registerMcpMutatingTools({ registerTool } as unknown as McpServer);
    const handler = registerTool.mock.calls[0][2];
    const result = await handler({ vault, text: "blocked capture", kind: "note", confirm_mutation: true });
    expect(result.isError).toBe(true);
    expect(result._meta.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ detail: { reason: "frozen-leaf" } });
    expect(snapshot(vault)).toEqual(before);
  });

  it("keeps an unfrozen standalone vault eligible for preflight", async () => {
    const { vault } = fixture(false);
    const before = snapshot(vault);
    const run = await runManagedWritePreflight({ vault, command: "page publish", env: {}, home: join(vault, "unused-home") });
    expect(run.result).toMatchObject({ ok: true, data: { mode: "standalone" } });
    expect(snapshot(vault)).toEqual(before);
  });
});
