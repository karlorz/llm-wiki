import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeRawSourceTarget,
  rawSourceTargetCandidates,
  rawSourceTargetExistsSync,
  rawSourceTargetExists,
} from "../../src/utils/raw-source.js";

describe("normalizeRawSourceTarget", () => {
  it("returns null for non-raw paths", () => {
    expect(normalizeRawSourceTarget("concepts/foo.md")).toBeNull();
  });

  it("strips wikilink citation wrapper", () => {
    expect(normalizeRawSourceTarget("^[raw/articles/x.md]")).toBe("raw/articles/x.md");
  });

  it("trims quotes", () => {
    expect(normalizeRawSourceTarget('"raw/transcripts/a.md"')).toBe("raw/transcripts/a.md");
  });

  it("accepts _archive/raw paths", () => {
    expect(normalizeRawSourceTarget("_archive/raw/transcripts/old.md")).toBe(
      "_archive/raw/transcripts/old.md",
    );
  });

  it("rejects traversal, normalized aliases, absolute paths, and NUL bytes", () => {
    expect(normalizeRawSourceTarget("raw/../SCHEMA.md")).toBeNull();
    expect(normalizeRawSourceTarget("raw/articles/./x.md")).toBeNull();
    expect(normalizeRawSourceTarget("/raw/articles/x.md")).toBeNull();
    expect(normalizeRawSourceTarget("raw/articles/x\0.md")).toBeNull();
  });
});

describe("rawSourceTargetCandidates", () => {
  it("returns empty for invalid target", () => {
    expect(rawSourceTargetCandidates("/vault", "entities/x")).toEqual([]);
  });

  it("adds .md extension candidate when omitted", () => {
    const vault = "/vault";
    const candidates = rawSourceTargetCandidates(vault, "raw/articles/slug");
    expect(candidates).toContain(join(vault, "raw/articles/slug"));
    expect(candidates).toContain(join(vault, "raw/articles/slug.md"));
  });

  it("includes archive fallback for raw/ paths", () => {
    const vault = "/vault";
    const candidates = rawSourceTargetCandidates(vault, "raw/transcripts/t.md");
    expect(candidates).toContain(join(vault, "_archive/raw/transcripts/t.md"));
  });
});

describe("rawSourceTargetExistsSync", () => {
  it("returns true when file exists under vault", () => {
    const vault = mkdtempSync(join(tmpdir(), "raw-src-"));
    mkdirSync(join(vault, "raw", "articles"), { recursive: true });
    writeFileSync(join(vault, "raw/articles/hit.md"), "body");
    expect(rawSourceTargetExistsSync(vault, "raw/articles/hit.md")).toBe(true);
    expect(rawSourceTargetExistsSync(vault, "raw/articles/miss.md")).toBe(false);
  });

  it("rejects a raw target that is a symlink to an outside file", () => {
    const vault = mkdtempSync(join(tmpdir(), "raw-src-link-"));
    const outside = join(mkdtempSync(join(tmpdir(), "raw-src-outside-")), "outside.md");
    mkdirSync(join(vault, "raw", "articles"), { recursive: true });
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(vault, "raw", "articles", "linked.md"));
    expect(rawSourceTargetExistsSync(vault, "raw/articles/linked.md")).toBe(false);
  });
});

describe("rawSourceTargetExists", () => {
  it("async existence matches sync", async () => {
    const vault = mkdtempSync(join(tmpdir(), "raw-src-async-"));
    mkdirSync(join(vault, "raw", "papers"), { recursive: true });
    writeFileSync(join(vault, "raw/papers/p.md"), "x");
    await expect(rawSourceTargetExists(vault, "raw/papers/p.md")).resolves.toBe(true);
  });

  it("rejects a symlinked raw parent directory", async () => {
    const vault = mkdtempSync(join(tmpdir(), "raw-src-parent-link-"));
    const outside = mkdtempSync(join(tmpdir(), "raw-src-parent-outside-"));
    mkdirSync(join(vault, "raw"), { recursive: true });
    writeFileSync(join(outside, "p.md"), "outside");
    symlinkSync(outside, join(vault, "raw", "papers"));
    await expect(rawSourceTargetExists(vault, "raw/papers/p.md")).resolves.toBe(false);
  });
});
