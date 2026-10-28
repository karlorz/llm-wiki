import { localMirrorMatches } from "./materialize.js";
import { setTimeout as delay } from "node:timers/promises";
import { eventsUrlFromMcp, parseMirrorSseBlock } from "./sse.js";
import { refreshAdmittedPages, structuredFromTool, type ReadPageFn, type RefreshPathReport } from "./refresh.js";
import { withMcpClient } from "../utils/mcp-client.js";
import { readCliPackageJson } from "../utils/package-info.js";

export interface InventoryFn {
  (after?: string): Promise<{ ok: boolean; vault_id?: string; entries?: Array<{ path: string; sha256: string }>; next_after?: string }>;
}
export function defaultInventory(input: { url: string; token: string; vaultId: string; fetchFn?: typeof fetch }): InventoryFn {
  return after => withMcpClient({ ...input, clientName: "skillwiki-mirror-inventory", version: readCliPackageJson().version }, async (client, signal) => {
    return structuredFromTool(await client.callTool({ name: "wiki_inventory", arguments: { vault: input.vaultId, after, limit: 100 } }, undefined, { signal })) as Awaited<ReturnType<InventoryFn>>;
  });
}
export async function startMarkdownMirrorWatcher(input: {
  home: string; vault: string; eventsUrl: string; mcpToken: string; expectedVaultId?: string;
  readPage: ReadPageFn; inventory: InventoryFn; signal: AbortSignal; fetchImpl?: typeof fetch;
  onReports?: (reports: RefreshPathReport[]) => void; onError?: (error: string) => void;
  reconcileMs?: number; retryMs?: number;
}): Promise<void> {
  const expectedVaultId = input.expectedVaultId ?? "central";
  const live = new Set<string>(), discovered = new Set<string>(), retry = new Set<string>();
  let backoff = input.retryMs ?? 1000;
  let scanAfter: string | undefined;
  let work: Promise<void> | undefined;
  let continuation: ReturnType<typeof setTimeout> | undefined;
  // One commit worker, with live events ahead of discovery. Failures are deferred
  // until a reconciliation tick, rather than occupying the front of every batch.
  const apply = () => {
    if (work || input.signal.aborted || (!live.size && !discovered.size)) return;
    work = (async () => {
      while (!input.signal.aborted && (live.size || discovered.size)) {
        const queue = live.size ? live : discovered;
        const path = queue.values().next().value!;
        live.delete(path); discovered.delete(path); retry.delete(path);
        const reports = await refreshAdmittedPages({ ...input, expectedVaultId, paths: [path] });
        for (const report of reports) {
          const terminal = ["delivered", "idempotent", "conflict", "denied"].includes(report.local.state)
            || ["missing", "too_large", "denied"].includes(report.central.state);
          if (!terminal) retry.add(report.path);
        }
        input.onReports?.(reports);
      }
    })().catch(error => input.onError?.(String(error))).finally(() => { work = undefined; apply(); });
  };
  let scanning = false;
  const reconcile = (full: boolean) => {
    for (const path of retry) discovered.add(path);
    retry.clear();
    apply();
    if (scanning || input.signal.aborted) return;
    clearTimeout(continuation);
    if (full) scanAfter = undefined;
    scanning = true;
    let advanced = false;
    // Only one resumable inventory page per tick. Inventory and remote delivery
    // run independently of the SSE reader, including a slow first inventory call.
    void (async () => {
      const page = await input.inventory(scanAfter);
      if (input.signal.aborted) return;
      if (!page.ok || !Array.isArray(page.entries)) throw new Error("wiki_inventory unavailable or invalid; upgrade the server");
      if (page.vault_id !== expectedVaultId) throw new Error("WRONG_VAULT inventory");
      for (const entry of page.entries) {
        if (typeof entry.path === "string" && !localMirrorMatches(input.vault, entry.path, entry.sha256)) discovered.add(entry.path);
      }
      if (page.next_after && page.next_after === scanAfter) throw new Error("INVALID_INVENTORY_CURSOR");
      scanAfter = page.next_after;
      advanced = true;
      apply();
    })().catch(error => { if (!input.signal.aborted) input.onError?.(error instanceof Error ? error.message : String(error)); })
      .finally(() => {
        scanning = false;
        if (advanced && scanAfter && !input.signal.aborted) continuation = setTimeout(() => reconcile(false), 100);
      });
  };
  while (!input.signal.aborted) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await (input.fetchImpl ?? fetch)(input.eventsUrl, {
        headers: { Authorization: `Bearer ${input.mcpToken}`, Accept: "text/event-stream" }, signal: input.signal,
      });
      if (!response.ok || !response.body) throw new Error("SSE unavailable");
      reader = response.body.getReader();
      const abort = () => { void reader?.cancel().catch(() => undefined); };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        reconcile(true);
        backoff = input.retryMs ?? 1000;
        let buffer = "";
        const decoder = new TextDecoder();
        let read = reader.read();
        let nextReconcile = Date.now() + (input.reconcileMs ?? 60_000);
        while (!input.signal.aborted) {
          const tick = new Promise<"tick">(resolve => { timer = setTimeout(() => resolve("tick"), Math.max(0, nextReconcile - Date.now())); });
          const result = await Promise.race([read, tick]);
          clearTimeout(timer);
          if (result === "tick") { reconcile(false); nextReconcile = Date.now() + (input.reconcileMs ?? 60_000); continue; }
          if (result.done) break;
          buffer = (buffer + decoder.decode(result.value, { stream: true })).replaceAll("\r\n", "\n");
          if (buffer.length > 1024 * 1024) throw new Error("SSE frame too large");
          let split: number;
          while ((split = buffer.indexOf("\n\n")) >= 0) {
            const parsed = parseMirrorSseBlock(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
            if (parsed?.kind === "resync") reconcile(true);
            if (parsed?.kind === "changed" && parsed.vault_id === expectedVaultId) {
              for (const path of parsed.paths) live.add(path);
              apply();
            }
          }
          read = reader.read();
        }
      } finally { input.signal.removeEventListener("abort", abort); }
    } catch (error) {
      if (input.signal.aborted) break;
      input.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
    }
    if (!input.signal.aborted) {
      await delay(backoff, undefined, { signal: input.signal }).catch(() => undefined);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  clearTimeout(continuation);
  await work;
}
export { eventsUrlFromMcp };
