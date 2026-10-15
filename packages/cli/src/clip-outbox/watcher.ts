import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ResolvedClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { readJournal, writeJournal, upsertJournal, type JournalEntry } from "./journal.js";
import { admittedArticle, sealCapture, snapshotPath, UnstableCapture } from "./seal.js";
import { readRegular } from "./files.js";
import { sha256Hex, type CreateOnlyPut } from "./upload.js";
import { buildReadyHint, type ReadyHint } from "./ready.js";

export type EventSource = (root: string, onEvent: (path: string, flags: number) => void) => Promise<() => Promise<void>>;
// Native FSEventStreamEventFlags: scan required, user/kernel drops, wrapped IDs,
// root changes, mount/unmount. Directory-level coalescing also requests a scan.
export const RESCAN_FLAGS = 0x01 | 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80 | 0x20000;
export const nativeEvents: EventSource = async (root, onEvent) => {
  if (process.platform !== "darwin") throw new Error("clip-outbox watch requires macOS FSEvents");
  const fsevents = createRequire(import.meta.url)("fsevents") as { watch(root: string, callback: (path: string, flags: number) => void): () => Promise<void> };
  return fsevents.watch(root, onEvent);
};
export interface WorkerDeps {
  put: CreateOnlyPut;
  ready: (hint: ReadyHint) => Promise<{ ok: boolean; status?: number }>;
  events?: EventSource;
  validate?: () => Promise<void>;
  seal?: typeof sealCapture;
  random?: () => number;
  onError?: (code: string) => void;
}

async function workerLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, ".skillwiki-clip-worker.lock");
  const owner = `owner-${process.pid}-${randomBytes(12).toString("hex")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, owner), "", { mode: 0o600, flag: "wx" });
      return async () => { await unlink(join(path, owner)); await rmdir(path); };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Delete only the observed owner's uniquely named file, never a newly
      // acquired lock. An incomplete or malformed lock needs attended review.
      const files = await readdir(path);
      if (files.length !== 1 || !/^owner-[0-9]+-[a-f0-9]+$/.test(files[0])) throw new Error("invalid worker lock");
      const pid = Number(files[0].split("-")[1]);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid worker lock");
      try { process.kill(pid, 0); throw new Error("clip worker already running"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      try { await unlink(join(path, files[0])); await rmdir(path); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
  }
  throw new Error("clip worker lock unavailable");
}

export async function startClipWorker(config: ResolvedClipOutboxConfig, deps: WorkerDeps): Promise<{ stop(): Promise<void>; entries(): JournalEntry[] }> {
  const release = await workerLock(config.root);
  let stopEvents: (() => Promise<void>) | undefined;
  let entries: JournalEntry[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queued = new Set<string>();
  let chain = Promise.resolve();
  let stopped = false;
  let fallback: ReturnType<typeof setInterval> | undefined;
  const save = async (entry: JournalEntry) => {
    entry.updatedAt = new Date().toISOString();
    entries = upsertJournal(entries, entry);
    await writeJournal(config.stateRoot, entries);
  };
  const submit = (fn: () => Promise<void>) => {
    chain = chain.then(async () => { if (!stopped) await fn(); }).catch(() => {
      // A journal/scan/config failure is not permission to continue publishing.
      stopped = true;
      deps.onError?.("WORKER_STOPPED");
    });
  };
  const schedule = (path: string, delay = config.debounceMs) => {
    if (stopped) return;
    clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => {
      timers.delete(path);
      if (queued.has(path)) return;
      queued.add(path);
      submit(async () => { queued.delete(path); await processPath(path); });
    }, Math.max(0, delay)));
  };
  const processPath = async (path: string) => {
    if (!admittedArticle(config.root, path)) return;
    let entry = entries.find((e) => e.source === path);
    if (entry?.state === "conflict") return;
    if (!entry) {
      const captureId = randomBytes(16).toString("hex");
      const title = basename(path, ".md").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
      entry = { captureId, source: path, articleKey: `raw/articles/${new Date().toISOString().slice(0, 10)}-${title}-${captureId}.md`, assetKeys: [], sha256: {}, state: "discovered" };
      await save(entry);
    }
    // Frozen source edits never produce a second capture or mutate the snapshot.
    if (entry.sourceSha256) {
      try {
        const input = await readRegular(config.root, path, config.maxArticleBytes);
        if (sha256Hex(input) !== entry.sourceSha256 && entry.reason !== "SEALED_SOURCE_CHANGED") {
          entry.reason = "SEALED_SOURCE_CHANGED"; await save(entry);
        }
      } catch {
        if (entry.reason !== "SEALED_SOURCE_UNAVAILABLE") { entry.reason = "SEALED_SOURCE_UNAVAILABLE"; await save(entry); }
      }
    }
    if (entry.state === "central-visible" || entry.state === "mirrored") return;
    if (entry.state === "held" && entry.sourceSha256) return;
    await deps.validate?.();
    try {
      if (!entry.sourceSha256) {
        entry.state = "preparing";
        await save(entry);
        entry = await (deps.seal ?? sealCapture)(config, entry);
        await save(entry);
      }
      await deps.validate?.();
      // No scheduling boundary between durable seal and the first upload.
      if (entry.state !== "notify-pending" && entry.state !== "article-verified") {
        for (const key of [...entry.assetKeys, entry.articleKey]) {
          if (entry.receipts?.[key]) continue;
          const body = await readRegular(join(config.stateRoot, entry.captureId), snapshotPath(config, entry, key), config.maxBundleBytes);
          if (sha256Hex(body) !== entry.sha256[key] || body.length !== entry.sizes?.[key]) throw new Error("SNAPSHOT_CHANGED");
          await deps.validate?.();
          const receipt = await deps.put(key, body);
          if (receipt.status === "conflict") {
            entry.state = "conflict"; entry.reason = "REMOTE_CONFLICT"; await save(entry); return;
          }
          entry.receipts = { ...entry.receipts, [key]: receipt.status };
          if (key === entry.articleKey) entry.state = "article-verified";
          else if (entry.assetKeys.every((k) => entry!.receipts?.[k])) entry.state = "assets-verified";
          await save(entry);
        }
      }
      entry.state = "notify-pending";
      await save(entry);
      const result = await deps.ready(buildReadyHint(config.vaultId, [...entry.assetKeys, entry.articleKey].map((key) => ({ path: key, sha256: entry!.sha256[key] }))));
      if (!result.ok) {
        if ([400, 401, 403, 404, 409, 413].includes(result.status ?? 0)) {
          entry.state = "held"; entry.reason = `READY_HTTP_${result.status}`; await save(entry); return;
        }
        throw new Error("READY_RETRY");
      }
      entry.state = "central-visible";
      entry.attempts = 0; entry.retryAt = undefined;
      await save(entry);
      // Mirror confirmation belongs to the inbound listener; never infer it here.
    } catch (e) {
      entry.attempts = (entry.attempts ?? 0) + 1;
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const unstable = e instanceof UnstableCapture;
      const persistent = [400, 401, 403].includes(status ?? 0) || (e instanceof Error && /SNAPSHOT_CHANGED|TOMBSTONE_HOLD|DELETE_INTENT_UNAVAILABLE/.test(e.message));
      entry.reason = unstable ? "INPUT_UNSTABLE" : persistent ? "DELIVERY_HELD" : entry.sourceSha256 ? "DELIVERY_RETRY" : "PREPARATION_HELD";
      if (!entry.sourceSha256 || persistent) entry.state = "held";
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(entry.attempts - 1, 6)) * (0.8 + (deps.random ?? Math.random)() * 0.2);
      entry.retryAt = persistent ? undefined : Date.now() + delay;
      await save(entry);
      if (!persistent) schedule(path, unstable ? config.debounceMs : delay);
    }
  };
  const scan = async () => {
    await deps.validate?.();
    const walk = async (dir: string): Promise<void> => {
      let children;
      try { children = await readdir(dir, { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
      for (const child of children) {
        const path = join(dir, child.name);
        if (child.isDirectory() && !child.name.startsWith(".")) await walk(path);
        else if (child.isFile() && admittedArticle(config.root, path)) schedule(path);
      }
    };
    await walk(join(config.root, "raw/articles"));
  };
  let scanQueued = false;
  const requestScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    submit(async () => { scanQueued = false; await scan(); });
  };
  try {
    entries = await readJournal(config.stateRoot);
    // Subscribe before recovery scan so a save during startup cannot be missed.
    stopEvents = await (deps.events ?? nativeEvents)(config.root, (path, flags) => {
      if (flags & RESCAN_FLAGS) { requestScan(); return; }
      const absolute = resolve(path);
      if (admittedArticle(config.root, absolute)) schedule(absolute);
      else if (absolute.startsWith(join(config.root, "raw/assets") + "/")) {
        for (const entry of entries) if (!entry.sourceSha256 && entry.source) schedule(entry.source);
      }
    });
    for (const entry of entries) if (entry.source) schedule(entry.source, Math.max(0, (entry.retryAt ?? Date.now()) - Date.now()));
    await scan();
    if (config.pollFallbackEnabled) fallback = setInterval(requestScan, config.reconcileSeconds * 1000);
    return {
      entries: () => structuredClone(entries),
      stop: async () => {
        stopped = true;
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
        if (fallback) clearInterval(fallback);
        await stopEvents?.();
        await chain;
        await release();
      },
    };
  } catch (e) {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    await stopEvents?.();
    await release();
    throw e;
  }
}
