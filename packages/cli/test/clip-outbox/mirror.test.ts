import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { admitMirrorPath, applyMirrorPaths, eventsUrlFromMcp, orderMirrorPaths, parseChangedSseBlock, wikiFetchPullLockDir } from "../../src/clip-outbox/mirror.js";
import { writeRegularExclusive } from "../../src/clip-outbox/files.js";
import { migrateClipOutbox } from "../../src/clip-outbox/migrate.js";
import { clipFixture } from "./fixture.js";

describe("inbound clip mirror listener", () => {
  it("admits only raw articles/assets and copies assets before articles", () => {
    expect(admitMirrorPath("raw/articles/note.md")).toBe(true);
    expect(admitMirrorPath("raw/assets/id/note.md")).toBe(true);
    expect(admitMirrorPath("projects/llm-wiki/README.md")).toBe(false);
    expect(admitMirrorPath("raw/articles/../secrets")).toBe(false);
    expect(orderMirrorPaths([
      "raw/articles/a.md",
      "raw/assets/id/x.bin",
      "raw/articles/a.md",
      "index.md",
    ])).toEqual(["raw/assets/id/x.bin", "raw/articles/a.md"]);
  });

  it("derives /events from the MCP URL and parses changed SSE blocks", () => {
    expect(eventsUrlFromMcp("https://wiki.karldigi.dev/mcp")).toBe("https://wiki.karldigi.dev/events");
    expect(parseChangedSseBlock("event: changed\ndata: {\"vault_id\":\"central\",\"paths\":[\"raw/articles/a.md\"]}")).toEqual({
      vault_id: "central",
      paths: ["raw/articles/a.md"],
    });
    expect(parseChangedSseBlock(": ping")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("skips when the wiki-fetch pull lock is contended and never overwrites different bytes", async () => {
    const { home, config } = await clipFixture();
    const objects = new Map([
      ["raw/assets/id/note.md", Buffer.from("asset")],
      ["raw/articles/a.md", Buffer.from("article")],
    ]);
    const lockDir = wikiFetchPullLockDir(home);
    await mkdir(lockDir, { recursive: true });
    const contended = await applyMirrorPaths({
      paths: ["raw/articles/a.md", "raw/assets/id/note.md"],
      getObject: async (key) => objects.get(key) ?? null,
      write: (rel, body) => writeRegularExclusive(config.mirrorRoot, rel, body),
      lock: async () => null,
    });
    expect(contended.copied).toEqual([]);
    expect(contended.skipped).toEqual(["raw/assets/id/note.md", "raw/articles/a.md"]);
    await rm(lockDir, { recursive: true });
    const copied = await applyMirrorPaths({
      paths: ["raw/articles/a.md", "raw/assets/id/note.md"],
      getObject: async (key) => objects.get(key) ?? null,
      write: (rel, body) => writeRegularExclusive(config.mirrorRoot, rel, body),
      lock: async () => async () => undefined,
    });
    expect(copied.copied).toEqual(["raw/assets/id/note.md", "raw/articles/a.md"]);
    expect(await readFile(join(config.mirrorRoot, "raw/articles/a.md"), "utf8")).toBe("article");
    await writeFile(join(config.mirrorRoot, "raw/articles/a.md"), "local-divergent");
    const conflict = await applyMirrorPaths({
      paths: ["raw/articles/a.md"],
      getObject: async (key) => objects.get(key) ?? null,
      write: (rel, body) => writeRegularExclusive(config.mirrorRoot, rel, body),
      lock: async () => async () => undefined,
    });
    expect(conflict.skipped).toEqual(["raw/articles/a.md"]);
    expect(await readFile(join(config.mirrorRoot, "raw/articles/a.md"), "utf8")).toBe("local-divergent");
    await rm(home, { recursive: true });
  });

  it("refreshes the inbound SSE plist without WatchPaths and without loading", async () => {
    const { home } = await clipFixture();
    const result = await migrateClipOutbox({ home, platform: "darwin", binaryPath: "/opt/homebrew/bin/skillwiki", nodePath: "/opt/homebrew/bin/node" });
    const plist = await readFile(result.mirrorPlistPath, "utf8");
    expect(plist).toContain("com.karlchow.skillwiki-mirror-sse");
    expect(plist).toContain("mirror-watch");
    expect(plist).not.toContain("<key>WatchPaths</key>");
    expect(plist).not.toContain(join(home, "wiki"));
    expect(result.loaded).toBe(false);
    expect(result.mirrorLoaded).toBe(false);
    await rm(home, { recursive: true });
  });
});
