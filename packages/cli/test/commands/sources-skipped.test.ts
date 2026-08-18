import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventorySources } from "../../src/utils/source-lifecycle.js";
import { readLogEvents } from "../../src/utils/log-events.js";
import { runSourcesSkipped } from "../../src/commands/sources-skipped.js";

const dirs: string[] = [];
function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-sources-skipped-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  mkdirSync(join(root, "raw", "papers"), { recursive: true });
  mkdirSync(join(root, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(root, "concepts"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // restore permissions in case unreadable files were chmoded 000
    try {
      chmodSync(join(dir, "raw", "articles", "unreadable.md"), 0o644);
    } catch {
      // ignore if file doesn't exist
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("source-skipped visibility events and sources skipped command", () => {
  // chmod 0o000 is not enforced on Windows, so unreadable-raw triggers are POSIX-only.
  it.skipIf(process.platform === "win32")("emits exactly one event across two inventory runs for unreadable raw (idempotency)", async () => {
    const root = makeVault();
    const unreadablePath = join(root, "raw", "articles", "unreadable.md");
    writeFileSync(unreadablePath, "some content that cannot be read");
    chmodSync(unreadablePath, 0o000);

    const first = await inventorySources({ vault: root, today: "2026-08-18" });
    expect(first.exitCode).toBe(0);
    expect(first.output?.diagnostics.some((d) => d.code === "source_unreadable")).toBe(true);

    const eventsAfterFirst = await readLogEvents(root);
    expect(eventsAfterFirst.ok).toBe(true);
    if (!eventsAfterFirst.ok) return;
    const skippedFirst = eventsAfterFirst.data.filter((e) => e.kind === "source-skipped");
    expect(skippedFirst).toHaveLength(1);
    expect(skippedFirst[0]).toMatchObject({
      kind: "source-skipped",
      target: "raw/articles/unreadable.md",
      metadata: {
        path: "raw/articles/unreadable.md",
        stage: "inventory",
      },
    });

    const second = await inventorySources({ vault: root, today: "2026-08-18" });
    expect(second.exitCode).toBe(0);

    const eventsAfterSecond = await readLogEvents(root);
    expect(eventsAfterSecond.ok).toBe(true);
    if (!eventsAfterSecond.ok) return;
    const skippedSecond = eventsAfterSecond.data.filter((e) => e.kind === "source-skipped");
    expect(skippedSecond).toHaveLength(1);
    expect(skippedSecond[0].operation_id).toBe(skippedFirst[0].operation_id);
  });

  it("emits event for non-md file under raw/articles or raw/papers with reason", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "articles", "image.png"), "fake png bytes");
    writeFileSync(join(root, "raw", "papers", "paper.pdf"), "fake pdf bytes");

    const inv = await inventorySources({ vault: root, today: "2026-08-18" });
    expect(inv.exitCode).toBe(0);

    const events = await readLogEvents(root);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const skipped = events.data.filter((e) => e.kind === "source-skipped");
    expect(skipped).toHaveLength(2);

    const articleSkipped = skipped.find((e) => e.target === "raw/articles/image.png");
    expect(articleSkipped).toBeDefined();
    expect(articleSkipped?.metadata).toMatchObject({
      path: "raw/articles/image.png",
      reason: "non-markdown file in source directory",
      stage: "inventory",
    });

    const paperSkipped = skipped.find((e) => e.target === "raw/papers/paper.pdf");
    expect(paperSkipped).toBeDefined();
    expect(paperSkipped?.metadata).toMatchObject({
      path: "raw/papers/paper.pdf",
      reason: "non-markdown file in source directory",
      stage: "inventory",
    });
  });

  it("emits nothing for files under raw/transcripts or other non-source subtrees", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "transcripts", "2026-08-18-call.txt"), "transcript text");
    writeFileSync(join(root, "raw", "transcripts", "2026-08-18-call.md"), "---\ntitle: Call\n---\nHello");

    const inv = await inventorySources({ vault: root, today: "2026-08-18" });
    expect(inv.exitCode).toBe(0);

    const events = await readLogEvents(root);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const skipped = events.data.filter((e) => e.kind === "source-skipped");
    expect(skipped).toHaveLength(0);
  });

  it("sources skipped lists events with path/reason/stage", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "articles", "data.json"), "{}");

    await inventorySources({ vault: root, today: "2026-08-18" });

    const result = await runSourcesSkipped({ vault: root });
    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) return;

    expect(result.result.data.events).toHaveLength(1);
    expect(result.result.data.events[0]).toMatchObject({
      path: "raw/articles/data.json",
      reason: "non-markdown file in source directory",
      stage: "inventory",
    });
    expect(result.result.data.humanHint).toContain("raw/articles/data.json");
  });

  it("operation_id is stable across scans and changes when file content changes", async () => {
    const root = makeVault();
    const filePath = join(root, "raw", "articles", "doc.pdf");
    writeFileSync(filePath, "version 1");

    await inventorySources({ vault: root, today: "2026-08-18" });
    const events1 = await readLogEvents(root);
    expect(events1.ok).toBe(true);
    if (!events1.ok) return;
    const skipped1 = events1.data.find((e) => e.target === "raw/articles/doc.pdf");
    expect(skipped1).toBeDefined();
    const opId1 = skipped1!.operation_id;

    // Scan again without change -> opId stays identical
    await inventorySources({ vault: root, today: "2026-08-18" });
    const events2 = await readLogEvents(root);
    expect(events2.ok).toBe(true);
    if (!events2.ok) return;
    const skipped2 = events2.data.find((e) => e.target === "raw/articles/doc.pdf");
    expect(skipped2!.operation_id).toBe(opId1);

    // Modify file content -> sha256 changes -> different opId generated
    writeFileSync(filePath, "version 2 (modified content)");
    await inventorySources({ vault: root, today: "2026-08-18" });
    const events3 = await readLogEvents(root);
    expect(events3.ok).toBe(true);
    if (!events3.ok) return;
    const skippedForDoc = events3.data.filter((e) => e.target === "raw/articles/doc.pdf");
    expect(skippedForDoc).toHaveLength(2);
    const opIds = skippedForDoc.map((e) => e.operation_id);
    expect(opIds[0]).not.toBe(opIds[1]);
  });
});
