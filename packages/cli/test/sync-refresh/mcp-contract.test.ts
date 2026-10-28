import { afterEach, describe, expect, it, vi } from "vitest";
const callTool = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/mcp-client.js", () => ({ withMcpClient: async (_input: unknown, run: (client: unknown, signal: AbortSignal) => unknown) => run({ callTool }, new AbortController().signal) }));
import { defaultReadPage, requestSnapshotViaMcp, snapshotStatusViaMcp } from "../../src/sync-refresh/refresh.js";
import { defaultInventory } from "../../src/sync-refresh/watcher.js";
afterEach(() => vi.resetAllMocks());
const input = { url: "https://example.invalid/mcp", token: "test", vaultId: "chosen" };
describe("explicit MCP contract", () => {
  it("sends selected vault on read and preserves a missing returned path for rejection", async () => {
    callTool.mockResolvedValue({ structuredContent: { ok: true, markdown: "x" } });
    const read = await defaultReadPage(input);
    expect((await read("concepts/a.md")).path).toBeUndefined();
    expect(callTool.mock.calls[0][0]).toEqual({ name: "wiki_read_page", arguments: { path: "concepts/a.md", vault: "chosen" } });
  });
  it("sends snapshot vault and request ID, rejects a mismatching response", async () => {
    callTool.mockResolvedValue({ structuredContent: { ok: true, vault_id: "other", state: "queued" } });
    expect((await requestSnapshotViaMcp(input)).ok).toBe(false);
    expect(callTool.mock.calls[0][0]).toEqual({ name: "wiki_snapshot_request", arguments: { vault: "chosen" } });
    expect((await snapshotStatusViaMcp({ ...input, requestId: "r1" })).ok).toBe(false);
    expect(callTool.mock.calls[1][0]).toEqual({ name: "wiki_snapshot_status", arguments: { vault: "chosen", request_id: "r1" } });
  });
  it("reports missing snapshot API as failed", async () => {
    callTool.mockRejectedValue(new Error("Method not found"));
    expect(await requestSnapshotViaMcp(input)).toMatchObject({ ok: false, state: "failed", error: "Method not found" });
  });
  it("uses inventory entries/next_after with explicit selector", async () => {
    callTool.mockResolvedValue({ structuredContent: { ok: true, vault_id: "chosen", entries: [], next_after: "b" } });
    expect(await defaultInventory(input)("a")).toMatchObject({ entries: [], next_after: "b" });
    expect(callTool.mock.calls[0][0]).toEqual({ name: "wiki_inventory", arguments: { vault: "chosen", after: "a", limit: 100 } });
  });
});
