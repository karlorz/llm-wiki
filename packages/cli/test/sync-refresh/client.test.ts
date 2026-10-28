import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { admitWikiMirrorPath } from "@skillwiki/shared";
import { localMirrorMatches, materializeAdmittedPage, sha256Buffer } from "../../src/sync-refresh/materialize.js";
import { refreshAdmittedPages, runSyncRefresh } from "../../src/sync-refresh/refresh.js";
import { loadMirrorHashState, mirrorHashStatePath } from "../../src/sync-refresh/hash-state.js";
import { acquireWikiFetchPullLock } from "../../src/utils/wiki-fetch-lock.js";
import { parseMirrorSseBlock } from "../../src/sync-refresh/sse.js";
import { startMarkdownMirrorWatcher } from "../../src/sync-refresh/watcher.js";

let base: string, root: string, home: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mirror-client-")));
  root = join(base, "wiki"); home = join(base, "home");
  await mkdir(root); await mkdir(home); await writeFile(join(root, ".WIKI_GIT_FROZEN"), "frozen\n");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });
const page = (path: string, text = "# delivered\n") => ({ ok: true, path, markdown: text, sha256: sha256Buffer(Buffer.from(text)), s3_verified: true });
const deliver = (rel: string, text = "new", priorHash?: string, vault = root) => materializeAdmittedPage({ vault, rel, body: Buffer.from(text), priorHash });
const refresh = (readPage = async (path: string) => page(path), paths = ["concepts/a.md"]) => refreshAdmittedPages({ vault: root, home, paths, readPage });

describe("safe materialization", () => {
  it("creates missing files, reads back bytes and replaces only the delivered base", async () => {
    expect((await refresh())[0].local.state).toBe("delivered");
    expect(await readFile(join(root, "concepts/a.md"), "utf8")).toBe("# delivered\n");
    expect((await refresh(async path => page(path, "next")))[0].local.state).toBe("delivered");
    expect((await refresh(async path => page(path, "next")))[0].local.state).toBe("idempotent");
    await writeFile(join(root, "concepts/a.md"), "local edit");
    expect((await refresh())[0].local.state).toBe("conflict");
    expect(await readFile(join(root, "concepts/a.md"), "utf8")).toBe("local edit");
  });
  it("accepts a clean Git HEAD base", async () => {
    await deliver("concepts/a.md", "base");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd: root });
    expect((await deliver("concepts/a.md")).decision).toBe("replaced");
  });
  it("raw remains create-only even with prior hash", async () => {
    await deliver("raw/articles/a.md", "base");
    expect((await deliver("raw/articles/a.md", "new", sha256Buffer(Buffer.from("base")))).decision).toBe("conflict");
  });
  it("requires a regular root frozen marker", async () => {
    await rm(join(root, ".WIKI_GIT_FROZEN"));
    expect((await deliver("concepts/a.md")).decision).toBe("denied");
  });
  it.each(["/concepts/a.md", "concepts/../a.md", "concepts\\a.md", "C:/concepts/a.md", "concepts/agents.md", "concepts/ClAuDe.md"])("denies %s", async path => {
    expect(admitWikiMirrorPath(path).ok).toBe(false);
    expect((await deliver(path)).decision).toBe("denied");
  });
  it("denies symlink root and symlink root ancestors", async () => {
    await symlink(root, join(base, "alias"));
    expect((await deliver("concepts/a.md", "x", undefined, join(base, "alias"))).decision).toBe("denied");
    await mkdir(join(root, "nested")); await writeFile(join(root, "nested/.WIKI_GIT_FROZEN"), "frozen");
    expect((await deliver("concepts/a.md", "x", undefined, join(base, "alias/nested"))).decision).toBe("denied");
  });
  it("denies parent and leaf symlinks", async () => {
    await mkdir(join(base, "outside")); await symlink(join(base, "outside"), join(root, "concepts"));
    expect((await deliver("concepts/a.md")).decision).toBe("denied");
    await rm(join(root, "concepts")); await mkdir(join(root, "concepts"));
    await writeFile(join(base, "outside/a.md"), "outside"); await symlink(join(base, "outside/a.md"), join(root, "concepts/a.md"));
    expect((await deliver("concepts/a.md")).decision).toBe("denied");
    expect(await readFile(join(base, "outside/a.md"), "utf8")).toBe("outside");
  });
  it("denies case-only collisions for directories and leaves", async () => {
    await mkdir(join(root, "Concepts"));
    expect((await deliver("concepts/a.md")).decision).toBe("denied");
    await rm(join(root, "Concepts"), { recursive: true });
    await deliver("concepts/A.md");
    expect((await deliver("concepts/a.md")).decision).toBe("denied");
  });
  it("never deletes a missing remote page", async () => {
    await deliver("concepts/a.md", "local");
    const reports = await refresh(async () => ({ ...page("concepts/a.md"), ok: false, error: "FILE_NOT_FOUND" }));
    expect(reports[0].central.state).toBe("missing");
    expect(await readFile(join(root, "concepts/a.md"), "utf8")).toBe("local");
  });
  it.each([ { path: "concepts/other.md" }, { vault_id: "other" }, { sha256: "0".repeat(64) }, { s3_verified: false } ])("rejects an invalid delivery %j", async patch => {
    const reports = await refresh(async path => ({ ...page(path), ...patch }));
    expect(reports[0].local.state).not.toBe("delivered");
    await expect(readFile(join(root, "concepts/a.md"))).rejects.toThrow();
  });
  it("shares wiki-fetch mutex and reports contention", async () => {
    const release = await acquireWikiFetchPullLock(home);
    try { expect((await refresh())[0].local.state).toBe("lock_contended"); } finally { await release!(); }
    expect((await refresh())[0].local.state).toBe("delivered");
  });
  it("scopes state by canonical root and vault; corrupt state grants no replacement", async () => {
    await refresh();
    const other = join(base, "other"); await mkdir(other);
    expect((await loadMirrorHashState(home, other, "central")).hashes).toEqual({});
    expect((await loadMirrorHashState(home, root, "other")).hashes).toEqual({});
    await writeFile(mirrorHashStatePath(home, root, "central"), "{invalid");
    expect((await refresh(async path => page(path, "different")))[0].local.state).toBe("conflict");
  });
  it("retains delivered receipts when an optional snapshot API is unavailable", async () => {
    vi.stubEnv("SKILLWIKI_MCP_URL", "https://example.invalid/mcp"); vi.stubEnv("SKILLWIKI_MCP_TOKEN", "test");
    const result = await runSyncRefresh({ vault: root, home, paths: ["concepts/a.md"], requestSnapshot: true,
      readPage: async path => page(path), fetchFn: async () => { throw new Error("server unavailable"); } });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.ok && result.result.data.pages[0].local.state).toBe("delivered");
    expect(result.result.ok && result.result.data.snapshot_request?.ok).toBe(false);
  });
  it("returns nonzero for partial missing pages and preserves successful receipt", async () => {
    vi.stubEnv("SKILLWIKI_MCP_URL", "https://example.invalid/mcp"); vi.stubEnv("SKILLWIKI_MCP_TOKEN", "test");
    const result = await runSyncRefresh({ vault: root, home, paths: ["concepts/a.md", "concepts/missing.md"], readPage: async path => path.includes("missing") ? { ok: false, error: "FILE_NOT_FOUND" } : page(path) });
    expect(result.exitCode).not.toBe(0);
    expect(result.result.ok && result.result.data.pages[0].local.state).toBe("delivered");
  });
});

describe("watcher recovery", () => {
  it("reconnect inventory discovers offline-created pages and aborts an idle read", async () => {
    const controller = new AbortController(); let connections = 0;
    const inventory = vi.fn(async () => ({ ok: true, vault_id: "central", entries: connections > 1 ? [{ path: "concepts/offline.md", sha256: "hint-only" }] : [] }));
    const fetchImpl = vi.fn(async () => {
      connections++;
      return new Response(new ReadableStream<Uint8Array>({ start(stream) { if (connections === 1) stream.close(); } }), { status: 200 });
    }) as unknown as typeof fetch;
    await startMarkdownMirrorWatcher({ home, vault: root, expectedVaultId: "central", eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
      readPage: async path => page(path), inventory, fetchImpl, retryMs: 1, onReports: reports => { if (reports.some(r => r.local.state === "delivered")) controller.abort(); } });
    expect(connections).toBe(2); expect(inventory).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, "concepts/offline.md"), "utf8")).toBe("# delivered\n");
  });
  it("retries failed duplicate events on periodic reconciliation; filters another vault", async () => {
    const controller = new AbortController(); let reads = 0;
    const readPage = vi.fn(async (path: string) => ++reads === 1 ? { ok: false, error: "TEMPORARY" } : page(path));
    const frame = 'event: changed\ndata: {"vault_id":"other","paths":["concepts/other.md"]}\n\nevent: changed\ndata: {"vault_id":"central","paths":["concepts/a.md","concepts/a.md"]}\n\n';
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({ start(s) { s.enqueue(new TextEncoder().encode(frame)); } }))) as typeof fetch;
    await startMarkdownMirrorWatcher({ home, vault: root, eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
      inventory: async () => ({ ok: true, vault_id: "central", entries: [] }), readPage, fetchImpl, reconcileMs: 5,
      onReports: reports => { if (reports.some(r => r.local.state === "delivered")) controller.abort(); } });
    expect(readPage.mock.calls.map(call => call[0])).toEqual(["concepts/a.md", "concepts/a.md"]);
  });
  it("reports an old server API and stops backoff immediately on abort", async () => {
    const controller = new AbortController(); const errors: string[] = [];
    await startMarkdownMirrorWatcher({ home, vault: root, eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
      inventory: async () => { throw new Error("Method not found: wiki_inventory"); }, readPage: async path => page(path),
      fetchImpl: (async () => new Response(new ReadableStream())) as typeof fetch,
      onError: error => { errors.push(error); controller.abort(); } });
    expect(errors[0]).toContain("wiki_inventory");
  });
});

it("leaves the local mutex available while a central read is pending", async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const result = refresh(async path => { entered(); return new Promise(resolve => { finish = resolve; }); });
  await reading;
  const release = await acquireWikiFetchPullLock(home);
  expect(release).not.toBeNull();
  await release!();
  finish(page("concepts/a.md"));
  expect((await result)[0].local.state).toBe("delivered");
});
it("parses multiline SSE data with a newline between lines", () => {
  expect(parseMirrorSseBlock('event: changed\r\ndata: {"vault_id":"central",\r\ndata: "paths":["concepts/a.md"]}')).toMatchObject({ kind: "changed", paths: ["concepts/a.md"] });
  // A newline inside a JSON string must remain invalid, rather than silently concatenate.
  expect(parseMirrorSseBlock('event: changed\ndata: {"vault_id":"cen\ndata: tral","paths":[]}')).toBeNull();
});
it("skips unchanged safe inventory hashes but verifies changed and absent pages", async () => {
  await deliver("concepts/same.md", "same");
  await deliver("concepts/changed.md", "base");
  const controller = new AbortController();
  const readPage = vi.fn(async path => page(path));
  const reported: string[] = [];
  await startMarkdownMirrorWatcher({ home, vault: root, eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
    inventory: async () => ({ ok: true, vault_id: "central", entries: [
      { path: "concepts/same.md", sha256: sha256Buffer(Buffer.from("same")) },
      { path: "concepts/changed.md", sha256: sha256Buffer(Buffer.from("changed")) },
      { path: "concepts/absent.md", sha256: sha256Buffer(Buffer.from("absent")) },
    ] }), readPage, fetchImpl: (async () => new Response(new ReadableStream())) as typeof fetch,
    onReports: reports => { reported.push(...reports.map(r => r.path)); if (reported.length === 2) controller.abort(); } });
  expect(readPage.mock.calls.map(call => call[0])).toEqual(["concepts/changed.md", "concepts/absent.md"]);
});
it("consumes split-CRLF live SSE while the initial inventory is pending", async () => {
  const controller = new AbortController();
  let finish!: (value: { ok: boolean; vault_id: string; entries: [] }) => void;
  let entered = false;
  const readPage = vi.fn(async path => { expect(entered).toBe(true); return page(path); });
  await startMarkdownMirrorWatcher({ home, vault: root, eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
    inventory: () => { entered = true; return new Promise(resolve => { finish = resolve; }); }, readPage,
    fetchImpl: (async () => new Response(new ReadableStream({ start(s) {
      for (const text of ['event: changed\r', '\ndata: {"vault_id":"central",\r', '\ndata: "paths":["concepts/live.md"]}\r', '\n\r', '\n']) s.enqueue(new TextEncoder().encode(text));
    } }))) as typeof fetch,
    onReports: () => controller.abort() });
  finish({ ok: true, vault_id: "central", entries: [] });
  expect(readPage).toHaveBeenCalledWith("concepts/live.md");
});

it("does not accept an inventory match through a symlink or unsafe path", async () => {
  await deliver("concepts/a.md", "same");
  const hash = sha256Buffer(Buffer.from("same"));
  expect(localMirrorMatches(root, "concepts/a.md", hash)).toBe(true);
  await symlink(root, join(base, "alias"));
  expect(localMirrorMatches(join(base, "alias"), "concepts/a.md", hash)).toBe(false);
  expect(localMirrorMatches(root, "concepts/../concepts/a.md", hash)).toBe(false);
  expect(localMirrorMatches(root, "concepts/a.md", "hint-only")).toBe(false);
});
it("does not immediately retry terminal missing or oversized pages", async () => {
  const controller = new AbortController(); let scans = 0;
  const readPage = vi.fn(async (path: string) => ({ ok: false, error: path.includes("missing") ? "FILE_NOT_FOUND" : "PAGE_TOO_LARGE" }));
  await startMarkdownMirrorWatcher({ home, vault: root, eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
    inventory: async () => {
      if (++scans === 4) controller.abort();
      return { ok: true, vault_id: "central", entries: scans === 1 ? ["missing", "large"].map(name => ({ path: `concepts/${name}.md`, sha256: "hint" })) : [] };
    }, readPage, reconcileMs: 20, fetchImpl: (async () => new Response(new ReadableStream())) as typeof fetch });
  expect(readPage.mock.calls.map(call => call[0])).toEqual(["concepts/missing.md", "concepts/large.md"]);
});
