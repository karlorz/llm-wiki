import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startClipWorker, nativeEvents, type EventSource } from "../../src/clip-outbox/watcher.js";
import { sealCapture, snapshotPath, UnstableCapture } from "../../src/clip-outbox/seal.js";
import { readJournal, type JournalEntry } from "../../src/clip-outbox/journal.js";
import { sha256Hex } from "../../src/clip-outbox/upload.js";
import { clipFixture, png, until } from "./fixture.js";

function events() {
  let notify!: (path: string, flags: number) => void;
  const source: EventSource = async (_, cb) => { notify = cb; return async () => {}; };
  return { source, emit: (p: string, f = 0x10000) => notify(p, f) };
}
function entry(source: string): JournalEntry {
  return { captureId: "abcdef1234567890", source, articleKey: "raw/articles/capture-abcdef1234567890.md", assetKeys: [], sha256: {}, state: "preparing" };
}

describe.skipIf(process.platform === "win32")("clip outbox event worker", () => {
  it("coalesces FSEvents, seals and immediately sends assets before article and ready without polling", async () => {
    const { home, config } = await clipFixture();
    const ev = events();
    const puts: string[] = [];
    const putTimes: number[] = [];
    let sealedAt = 0;
    const ready = vi.fn(async () => ({ ok: true }));
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const worker = await startClipWorker(config, {
      events: ev.source,
      seal: async (...args) => { const result = await sealCapture(...args); sealedAt = Date.now(); return result; },
      put: async (key) => { puts.push(key); putTimes.push(Date.now()); return { status: "created" }; }, ready,
    });
    try {
      const source = join(config.root, "raw/articles/test.md");
      await writeFile(join(config.root, "raw/assets/image.png"), png);
      await writeFile(source, "hello ![[raw/assets/image.png]]");
      for (let i = 0; i < 20; i++) ev.emit(source);
      ev.emit(join(home, "wiki/raw/articles/inbound.md"));
      await until(() => worker.entries()[0]?.state === "central-visible");
      expect(worker.entries()).toHaveLength(1);
      expect(puts).toHaveLength(3);
      expect(puts[0]).toBe("raw/assets/image.png");
      expect(puts[1]).toMatch(/raw\/assets\/.+\/note.md/);
      expect(puts[2]).toMatch(/^raw\/articles\//);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(putTimes[0] - sealedAt).toBeLessThan(1000);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      const saved = (await readJournal(config.stateRoot))[0];
      expect(saved.sizes?.[saved.articleKey]).toBeGreaterThan(0);
      expect(saved.receipts?.[saved.articleKey]).toBe("created");
    } finally { setIntervalSpy.mockRestore(); await worker.stop(); await rm(home, { recursive: true }); }
  });

  it("recovers startup backlog and overflow/coalesced directory saves without a file event", async () => {
    const { home, config } = await clipFixture();
    const ev = events();
    await writeFile(join(config.root, "raw/articles/startup.md"), "startup");
    const put = vi.fn(async () => ({ status: "created" as const }));
    const worker = await startClipWorker(config, { events: ev.source, put, ready: async () => ({ ok: true }) });
    try {
      await until(() => worker.entries()[0]?.state === "central-visible");
      const nested = join(config.root, "raw/articles/nested");
      await mkdir(nested);
      await writeFile(join(nested, "overflow.md"), "overflow");
      ev.emit(config.root, 0x02 | 0x04 | 0x01);
      ev.emit(config.root, 0x20000);
      await until(() => worker.entries().filter((e) => e.state === "central-visible").length === 2);
      expect(put.mock.calls.length).toBe(4);
    } finally { await worker.stop(); await rm(home, { recursive: true }); }
  });

  it("resumes notify-pending after restart without uploading or inferring mirrored", async () => {
    const { home, config } = await clipFixture();
    await writeFile(join(config.root, "raw/articles/retry.md"), "retry");
    const put = vi.fn(async () => ({ status: "created" as const }));
    let worker = await startClipWorker(config, { events: events().source, put, ready: async () => ({ ok: false, status: 503 }) });
    await until(() => !!worker.entries()[0]?.retryAt);
    expect(worker.entries()[0].state).toBe("notify-pending");
    await worker.stop();
    const before = put.mock.calls.length;
    worker = await startClipWorker(config, { events: events().source, put, ready: async () => ({ ok: true }) });
    try {
      await until(() => worker.entries()[0]?.state === "central-visible");
      expect(put).toHaveBeenCalledTimes(before);
      expect(worker.entries()[0].state).not.toBe("mirrored");
    } finally { await worker.stop(); await rm(home, { recursive: true }); }
  });

  it("holds a conflict before article and preserves one root owner", async () => {
    const { home, config } = await clipFixture();
    await writeFile(join(config.root, "raw/articles/conflict.md"), "conflict");
    const put = vi.fn(async (_key: string) => ({ status: "conflict" as const }));
    const worker = await startClipWorker(config, { events: events().source, put, ready: async () => ({ ok: true }) });
    try {
      await expect(startClipWorker(config, { events: events().source, put, ready: async () => ({ ok: true }) })).rejects.toThrow(/already running/);
      await until(() => worker.entries()[0]?.state === "conflict");
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0][0]).toMatch(/^raw\/assets\//);
    } finally { await worker.stop(); await rm(home, { recursive: true }); }
  });

  it("fails closed on corrupt journal", async () => {
    const { home, config } = await clipFixture();
    await writeFile(join(config.stateRoot, "journal.json"), "{torn");
    const put = vi.fn();
    await expect(startClipWorker(config, { events: events().source, put, ready: async () => ({ ok: true }) })).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    await rm(home, { recursive: true });
  });

  it.skipIf(process.platform !== "darwin")("uses native FSEvents for a nested file save", async () => {
    const { home, config } = await clipFixture();
    let observed = false;
    const stop = await nativeEvents(config.root, (path) => { if (path.endsWith("native.md")) observed = true; });
    try {
      await mkdir(join(config.root, "raw/articles/nested"));
      await writeFile(join(config.root, "raw/articles/nested/native.md"), "native");
      await until(() => observed, 5000);
    } finally { await stop(); await rm(home, { recursive: true }); }
  });
});

describe.skipIf(process.platform === "win32")("stable immutable bundle seal", () => {
  it("restarts on an article or local dependency change during the stable window", async () => {
    const { home, config } = await clipFixture();
    const source = join(config.root, "raw/articles/changing.md");
    const asset = join(config.root, "raw/assets/image.png");
    await writeFile(source, "A ![[raw/assets/image.png]]"); await writeFile(asset, png);
    await expect(sealCapture(config, entry(source), { delay: async () => { await writeFile(source, "B"); } })).rejects.toBeInstanceOf(UnstableCapture);
    await writeFile(source, "A ![[raw/assets/image.png]]");
    await expect(sealCapture(config, entry(source), { delay: async () => { await writeFile(asset, Buffer.concat([png, Buffer.from("change")])); } })).rejects.toBeInstanceOf(UnstableCapture);
    await rm(home, { recursive: true });
  });
  it("rejects symlinks and keeps original plus hashed snapshots outside raw", async () => {
    const { home, config } = await clipFixture();
    const source = join(config.root, "raw/articles/sealed.md");
    await writeFile(source, "original ![[raw/assets/image.png]]");
    await writeFile(join(home, "outside.png"), png);
    await symlink(join(home, "outside.png"), join(config.root, "raw/assets/image.png"));
    await expect(sealCapture(config, entry(source))).rejects.toThrow(/symlink/);
    await rm(join(config.root, "raw/assets/image.png"));
    await writeFile(join(config.root, "raw/assets/image.png"), png);
    const sealed = await sealCapture(config, entry(source), { delay: async () => {} });
    const bytes = await readFile(snapshotPath(config, sealed, sealed.articleKey));
    expect(sha256Hex(bytes)).toBe(sealed.sha256[sealed.articleKey]);
    expect(sealed.assetKeys).toContain("raw/assets/image.png");
    expect(await readFile(source, "utf8")).toContain("original");
    await rm(home, { recursive: true });
  });
});

describe.skipIf(process.platform === "win32")("locked realtime timing", () => {
  it("waits 500 ms quiet plus 500 ms matching hashes, then uploads without an extra timer", async () => {
    const { home, config } = await clipFixture();
    config.debounceMs = 500; config.stableHashMs = 500;
    const ev = events();
    const put = vi.fn(async () => ({ status: "created" as const }));
    const worker = await startClipWorker(config, { events: ev.source, put, ready: async () => ({ ok: true }) });
    try {
      const source = join(config.root, "raw/articles/2026-clip-文章.md");
      await writeFile(source, "stable");
      const started = Date.now();
      ev.emit(source);
      await new Promise((r) => setTimeout(r, 450));
      expect(put).not.toHaveBeenCalled();
      await until(() => worker.entries()[0]?.state === "central-visible");
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(worker.entries()).toHaveLength(1);
    } finally { await worker.stop(); await rm(home, { recursive: true }); }
  });
});
