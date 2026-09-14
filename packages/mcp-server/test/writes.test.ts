import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCaptureProject, renderCaptureMarkdown, slugify, wikiCapture, wikiLogAppend, type CaptureKind } from "../src/tools/writes.js";
import { handleWikiReadPage, MAX_READ_PAGE_BYTES } from "../src/tools/reads.js";
import { ReconcileGate } from "../src/reconcile.js";
import { S3PutError, sha256Bytes } from "../src/txn.js";
import { makeS3Store, makeTempVault } from "./helpers.js";

function readyGate(): ReconcileGate {
  const gate = new ReconcileGate(async () => undefined);
  return gate;
}

describe("wiki_capture validation", () => {
  it("slugifies the title for a new transcripts path", () => {
    expect(slugify("Fix the template mismatch!")).toBe("fix-the-template-mismatch");
  });

  it("empty or punctuation-only titles return capture", () => {
    expect(slugify("")).toBe("capture");
    expect(slugify("!!!")).toBe("capture");
  });

  it("empty, whitespace, and invalid slugs return null", () => {
    expect(normalizeCaptureProject("")).toBeNull();
    expect(normalizeCaptureProject("   ")).toBeNull();
    expect(normalizeCaptureProject("Not A Slug")).toBeNull();
  });

  it("renders ad-hoc capture frontmatter that the raw schema accepts", () => {
    const md = renderCaptureMarkdown({
      kind: "idea",
      project: "llm-wiki",
      title: "Fix the template mismatch",
      content: "Body here",
      date: "2026-09-13",
    });
    expect(md).toContain("kind: idea");
    expect(md).toContain('project: "[[llm-wiki]]"');
    expect(md).toContain("ingested: 2026-09-13");
    expect(md).toContain("source_url: null");
    expect(md).toContain("# idea: Fix the template mismatch");
    expect(md).toContain("Body here");
  });

  it("rejects live credential patterns instead of writing", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => {
        throw new Error("put should not run");
      },
    }, {
      kind: "note",
      project: "llm-wiki",
      title: "leak",
      content: "Authorization: Bearer sk-live-super-secret-token-value-123456",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("SENSITIVE_CONTENT_DETECTED");
  });

  it("rejects an unknown kind without writing a transcript", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => {
        throw new Error("put should not run");
      },
    }, {
      kind: "session-log" as CaptureKind,
      project: "llm-wiki",
      title: "should-not-write",
      content: "no file",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("USAGE");
    expect((result as { writer_id?: string }).writer_id).toBeUndefined();
    expect(await readdir(join(vault, "raw", "transcripts"))).toEqual([]);
  });

  it("rejects an unknown project without writing a transcript", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => {
        throw new Error("put should not run");
      },
    }, {
      kind: "note",
      project: "does-not-exist",
      title: "should-not-write",
      content: "no file",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("USAGE");
    expect((result as { writer_id?: string }).writer_id).toBeUndefined();
    expect(await readdir(join(vault, "raw", "transcripts"))).toEqual([]);
  });
});

describe("wiki_log_append", () => {
  it("appends a newest-last log entry after S3 success", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const existing = await readFile(join(vault, "log.md"), "utf8");
    const s3 = makeS3Store({ "log.md": existing });
    const result = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: s3.putObject,
      getObject: s3.getObject,
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: "capture | note: hello from mcp" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.path).toBe("log.md");
    expect(result.appended).toBe(true);
    expect(result.s3_verified).toBe(true);
    expect(result.operation_id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.event_path).toBe(`meta/log-events/2026-09-14/${result.operation_id}.json`);
    expect(s3.store.has("log.md")).toBe(true);
    expect(s3.store.has(result.event_path)).toBe(true);
    const log = await readFile(join(vault, "log.md"), "utf8");
    expect(log).toContain("## [2026-09-14] capture | note: hello from mcp");
    expect(log).toContain(`<!-- skillwiki-log-event:${result.operation_id} -->`);
  });

  it("writes an event record and receipt when log.md already exceeds 256 KiB", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const canary = "capture | note: oversized-canary-9f3a";
    const oversized = `${"x".repeat(MAX_READ_PAGE_BYTES + 64)}\n`;
    await writeFile(join(vault, "log.md"), oversized, "utf8");
    const s3 = makeS3Store({ "log.md": oversized });
    const result = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: s3.putObject,
      getObject: s3.getObject,
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: canary });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.appended).toBe(true);
    expect(result.s3_verified).toBe(true);
    expect(result.event_path).toMatch(/^meta\/log-events\/2026-09-14\/[0-9a-f]{64}\.json$/);
    expect(result.appended_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.event_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.log_sha256).toMatch(/^[0-9a-f]{64}$/);
    const eventBytes = s3.store.get(result.event_path);
    expect(eventBytes).toBeDefined();
    expect(sha256Bytes(eventBytes!)).toBe(result.event_sha256);
    expect(eventBytes!.toString("utf8")).toContain(canary);
    const eventFiles = await readdir(join(vault, "meta", "log-events", "2026-09-14"));
    expect(eventFiles).toHaveLength(1);
  });

  it("replays the same content on the same UTC date without a second event", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const existing = await readFile(join(vault, "log.md"), "utf8");
    const s3 = makeS3Store({ "log.md": existing });
    const ctx = {
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: s3.putObject,
      getObject: s3.getObject,
      now: () => new Date("2026-09-14T12:00:00Z"),
    };
    const first = await wikiLogAppend(ctx, { content: "capture | note: replay-me" });
    const second = await wikiLogAppend(ctx, { content: "capture | note: replay-me" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.event_path).toBe(first.event_path);
    expect(second.operation_id).toBe(first.operation_id);
    const eventFiles = await readdir(join(vault, "meta", "log-events", "2026-09-14"));
    expect(eventFiles).toHaveLength(1);
  });

  it("repairs a missing projection block on replay after log.md put failure", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const existing = await readFile(join(vault, "log.md"), "utf8");
    const s3 = makeS3Store({ "log.md": existing });
    let logPuts = 0;
    const first = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: async (path, body) => {
        if (path === "log.md") {
          logPuts += 1;
          throw new S3PutError("simulated log.md put failure");
        }
        await s3.putObject(path, body);
      },
      getObject: s3.getObject,
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: "capture | note: repair-me" });
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected first append to fail");
    expect(first.error).toBe("S3_PUT_FAILED");
    expect(logPuts).toBe(1);
    const eventKeys = [...s3.store.keys()].filter((k) => k.startsWith("meta/log-events/"));
    expect(eventKeys).toHaveLength(1);
    expect(await readFile(join(vault, "log.md"), "utf8")).toBe(existing);

    const replay = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: s3.putObject,
      getObject: s3.getObject,
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: "capture | note: repair-me" });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay ok");
    expect(replay.appended).toBe(false);
    expect(replay.projection_repaired).toBe(true);
    expect(replay.s3_verified).toBe(true);
    const log = await readFile(join(vault, "log.md"), "utf8");
    expect(log).toContain("## [2026-09-14] capture | note: repair-me");
    expect(log).toContain(`<!-- skillwiki-log-event:${replay.operation_id} -->`);
    expect(await readdir(join(vault, "meta", "log-events", "2026-09-14"))).toHaveLength(1);
  });

  it("fails the append when event GetObject is missing or mismatched", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const existing = await readFile(join(vault, "log.md"), "utf8");
    const missing = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: async () => undefined,
      getObject: async () => null,
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: "capture | note: no-verify" });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected failure");
    expect(missing.error).toBe("S3_VERIFY_FAILED");

    const s3 = makeS3Store({ "log.md": existing });
    const mismatched = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: s3.putObject,
      getObject: async (path) => {
        const got = await s3.getObject(path);
        if (path.startsWith("meta/log-events/") && got) {
          return { sha256: "0".repeat(64), body: Buffer.from("not-the-event") };
        }
        return got;
      },
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: "capture | note: bad-verify" });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) throw new Error("expected failure");
    expect(mismatched.error).toBe("S3_VERIFY_FAILED");
  });

  it("lets wiki_read_page verify an oversized append via event path and tail_bytes", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const canary = "capture | note: e2e-canary-tail";
    const oversized = `${"# Vault Log\n\n"}${"y".repeat(MAX_READ_PAGE_BYTES)}\n`;
    await writeFile(join(vault, "log.md"), oversized, "utf8");
    const s3 = makeS3Store({ "log.md": oversized });
    const append = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: s3.putObject,
      getObject: s3.getObject,
      now: () => new Date("2026-09-14T12:00:00Z"),
    }, { content: canary });
    expect(append.ok).toBe(true);
    if (!append.ok) throw new Error("expected ok");

    const full = await handleWikiReadPage(
      { vaultDir: vault, gate, getObject: s3.getObject },
      { path: "log.md" },
    );
    expect(full.ok).toBe(false);
    if (full.ok || full.error !== "PAGE_TOO_LARGE") throw new Error("expected PAGE_TOO_LARGE");
    expect(full.sha256).toBe(append.log_sha256);
    expect(full.byte_length).toBeGreaterThan(MAX_READ_PAGE_BYTES);
    expect(full.s3_verified).toBe(true);

    const event = await handleWikiReadPage(
      { vaultDir: vault, gate, getObject: s3.getObject },
      { path: append.event_path },
    );
    expect(event.ok).toBe(true);
    if (!event.ok) throw new Error("expected event read");
    expect(event.markdown).toContain(canary);
    expect(event.sha256).toBe(append.event_sha256);
    expect(event.s3_verified).toBe(true);

    const tail = await handleWikiReadPage(
      { vaultDir: vault, gate, getObject: s3.getObject },
      { path: "log.md", tail_bytes: 2048 },
    );
    expect(tail.ok).toBe(true);
    if (!tail.ok) throw new Error("expected tail");
    expect(tail.markdown).toContain(canary);
    expect(tail.sha256).toBe(append.log_sha256);
    expect(tail.byte_length).toBe(full.byte_length);
    expect(tail.s3_verified).toBe(true);
  });
});

describe("wiki_capture write", () => {
  it("creates a new transcripts file and does not touch existing pages", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => undefined,
      now: () => new Date("2026-09-13T12:00:00Z"),
    }, {
      kind: "note",
      project: "llm-wiki",
      title: "hello from mcp",
      content: "A capture body",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.path).toBe("raw/transcripts/2026-09-13-note-hello-from-mcp.md");
    expect(result.writer_id).toBe("macos-dev");
    expect(await readFile(join(vault, result.path), "utf8")).toContain("A capture body");
    await expect(access(join(vault, "concepts", "alpha.md"))).resolves.toBeUndefined();
  });

  it("fail-closes capture-write when S3 put fails and leaves no transcript", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => {
        throw new S3PutError("simulated capture put failure");
      },
      now: () => new Date("2026-09-13T12:00:00Z"),
    }, {
      kind: "note",
      project: "llm-wiki",
      title: "should-not-land",
      content: "no file",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("S3_PUT_FAILED");
    expect((result as { writer_id?: string }).writer_id).toBeUndefined();
    expect(await readdir(join(vault, "raw", "transcripts"))).toEqual([]);
  });
});
