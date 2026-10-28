import { expect, it, vi } from "vitest";
vi.mock("../../src/sync-refresh/materialize.js", () => ({ localMirrorMatches: () => false }));
vi.mock("../../src/sync-refresh/refresh.js", () => ({
  structuredFromTool: (value: unknown) => value,
  refreshAdmittedPages: vi.fn(async ({ paths }: { paths: string[] }) => paths.map(path => ({
    path, central: { state: path === "concepts/late.md" ? "verified" : "error" },
    local: { state: path === "concepts/late.md" ? "delivered" : "skipped" },
    github: { state: "unknown", observation: "cached_origin_ref", live_backup_confirmed: false },
  }))),
}));
import { refreshAdmittedPages } from "../../src/sync-refresh/refresh.js";
import { startMarkdownMirrorWatcher } from "../../src/sync-refresh/watcher.js";
it("retains over 100 retryable failures fairly and prioritizes a later live event", async () => {
  const controller = new AbortController();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let failures = 0, scans = 0;
  try {
    await startMarkdownMirrorWatcher({ home: "/unused", vault: "/unused", eventsUrl: "https://example.invalid/events", mcpToken: "test", signal: controller.signal,
      inventory: async () => ({ ok: true, vault_id: "central", entries: ++scans === 1 ? Array.from({ length: 100 }, (_, i) => ({ path: `concepts/fail${i}.md`, sha256: "hint" })) : Array.from({ length: 20 }, (_, i) => ({ path: `concepts/fail${i + 100}.md`, sha256: "hint" })), next_after: scans === 1 ? "cursor" : undefined }),
      readPage: async () => { throw new Error("mock refresh owns read"); }, reconcileMs: 5,
      fetchImpl: (async () => new Response(new ReadableStream({ start(s) { stream = s; } }))) as typeof fetch,
      onReports: reports => {
        if (reports[0].path === "concepts/late.md") controller.abort();
        else if (++failures === 205) stream.enqueue(new TextEncoder().encode('event: changed\ndata: {"vault_id":"central","paths":["concepts/late.md"]}\n\n'));
      } });
  } finally { controller.abort(); }
  const paths = vi.mocked(refreshAdmittedPages).mock.calls.flatMap(([input]) => input.paths);
  expect(new Set(paths.filter(path => path !== "concepts/late.md")).size).toBeGreaterThan(100);
  expect(paths.at(-1)).toBe("concepts/late.md");
  expect(failures).toBeLessThan(220);
});
