import { describe, it, expect } from "vitest";
import {
  collectClaimedTranscripts,
  normalizeRawTranscriptRef,
  type ClaimIndexSource,
} from "../../src/utils/transcript-claims.js";

describe("normalizeRawTranscriptRef", () => {
  it("accepts an exact raw transcript path", () => {
    expect(normalizeRawTranscriptRef("raw/transcripts/2026-07-01-task-x.md")).toBe(
      "raw/transcripts/2026-07-01-task-x.md",
    );
  });

  it("accepts a trimmed raw transcript path", () => {
    expect(normalizeRawTranscriptRef("  raw/transcripts/2026-07-01-task-x.md  ")).toBe(
      "raw/transcripts/2026-07-01-task-x.md",
    );
  });

  it("rejects non-transcript paths", () => {
    expect(normalizeRawTranscriptRef("raw/articles/2026-07-01-x.md")).toBeUndefined();
    expect(normalizeRawTranscriptRef("projects/llm-wiki/README.md")).toBeUndefined();
    expect(normalizeRawTranscriptRef("")).toBeUndefined();
  });

  it("rejects traversal and Windows separators", () => {
    expect(normalizeRawTranscriptRef("raw/transcripts/../articles/x.md")).toBeUndefined();
    expect(normalizeRawTranscriptRef("raw\\transcripts\\2026-07-01-x.md")).toBeUndefined();
  });

  it("rejects non-Markdown raw transcript values", () => {
    expect(normalizeRawTranscriptRef("raw/transcripts/2026-07-01-x.txt")).toBeUndefined();
    expect(normalizeRawTranscriptRef("raw/transcripts/2026-07-01-x")).toBeUndefined();
  });

  it("rejects non-string values", () => {
    expect(normalizeRawTranscriptRef(42)).toBeUndefined();
    expect(normalizeRawTranscriptRef(["raw/transcripts/x.md"])).toBeUndefined();
    expect(normalizeRawTranscriptRef(undefined)).toBeUndefined();
    expect(normalizeRawTranscriptRef(null)).toBeUndefined();
  });
});

describe("collectClaimedTranscripts", () => {
  const item = (overrides: Partial<ClaimIndexSource> = {}): ClaimIndexSource => ({
    relDir: "projects/llm-wiki/work/2026-07-01-x",
    ...overrides,
  });

  it("collects exact source references with their owning work item", () => {
    const index = collectClaimedTranscripts([
      item({ source: "raw/transcripts/2026-07-01-task-a.md" }),
    ]);
    expect(index.claimedByPath.get("raw/transcripts/2026-07-01-task-a.md")).toBe(
      "projects/llm-wiki/work/2026-07-01-x",
    );
    expect(index.diagnostics).toEqual([]);
  });

  it("collects sources and closes as single values or arrays", () => {
    const index = collectClaimedTranscripts([
      item({ source: "raw/transcripts/2026-07-01-task-b.md" }),
      item({ sources: "raw/transcripts/2026-07-01-task-c.md" }),
      item({
        sources: [
          "raw/transcripts/2026-07-01-task-d.md",
          "raw/transcripts/2026-07-01-task-e.md",
        ],
      }),
      item({ closes: "raw/transcripts/2026-07-01-task-f.md" }),
      item({
        closes: [
          "raw/transcripts/2026-07-01-task-g.md",
          "raw/transcripts/2026-07-01-task-h.md",
        ],
      }),
    ]);
    for (const suffix of ["b", "c", "d", "e", "f", "g", "h"]) {
      expect(index.claimedByPath.has(`raw/transcripts/2026-07-01-task-${suffix}.md`)).toBe(true);
    }
  });

  it("ignores non-path and non-transcript values", () => {
    const index = collectClaimedTranscripts([
      item({ source: 42, closes: "raw/articles/2026-07-01-x.md" }),
      item({ source: "raw/transcripts/../escape.md", closes: ["not a path"] }),
    ]);
    expect(index.claimedByPath.size).toBe(0);
  });

  it("deduplicates repeated references with the later work item as owner", () => {
    const index = collectClaimedTranscripts([
      item({ source: "raw/transcripts/2026-07-01-task-a.md" }),
      item({
        closes: ["raw/transcripts/2026-07-01-task-a.md"],
        relDir: "projects/llm-wiki/work/2026-07-02-y",
      }),
    ]);
    expect(index.claimedByPath.size).toBe(1);
    expect(index.claimedByPath.get("raw/transcripts/2026-07-01-task-a.md")).toBe(
      "projects/llm-wiki/work/2026-07-02-y",
    );
  });

  it("reports malformed attempted raw-transcript references in source, sources, and closes", () => {
    const index = collectClaimedTranscripts([
      item({ source: "raw/transcripts/2026-07-01-a.txt" }),
      item({
        relDir: "projects/llm-wiki/work/2026-07-02-y",
        sources: ["raw/transcripts/../escape.md", "raw/transcripts/2026-07-01-b.md"],
      }),
      item({
        relDir: "projects/llm-wiki/work/2026-07-03-z",
        closes: "raw\\transcripts\\2026-07-01-c.md",
      }),
    ]);
    // Malformed attempts are never treated as claims; well-formed entries still are.
    expect(index.claimedByPath.has("raw/transcripts/2026-07-01-a.txt")).toBe(false);
    expect(index.claimedByPath.has("raw/transcripts/../escape.md")).toBe(false);
    expect(index.claimedByPath.has("raw\\transcripts\\2026-07-01-c.md")).toBe(false);
    expect(index.claimedByPath.get("raw/transcripts/2026-07-01-b.md")).toBe(
      "projects/llm-wiki/work/2026-07-02-y",
    );
    expect(index.diagnostics).toEqual([
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-01-x",
        field: "source",
        value: "raw/transcripts/2026-07-01-a.txt",
      },
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-02-y",
        field: "sources",
        value: "raw/transcripts/../escape.md",
      },
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-03-z",
        field: "closes",
        value: "raw\\transcripts\\2026-07-01-c.md",
      },
    ]);
  });

  it("reports a duplicate exact claim with both work-item directories", () => {
    const index = collectClaimedTranscripts([
      item({ source: "raw/transcripts/2026-07-01-task-a.md" }),
      item({
        relDir: "projects/llm-wiki/work/2026-07-02-y",
        closes: ["raw/transcripts/2026-07-01-task-a.md"],
      }),
    ]);
    // Map semantics are preserved: the later work item remains the owner.
    expect(index.claimedByPath.size).toBe(1);
    expect(index.claimedByPath.get("raw/transcripts/2026-07-01-task-a.md")).toBe(
      "projects/llm-wiki/work/2026-07-02-y",
    );
    expect(index.diagnostics).toEqual([
      {
        kind: "duplicate",
        path: "raw/transcripts/2026-07-01-task-a.md",
        owners: [
          "projects/llm-wiki/work/2026-07-01-x",
          "projects/llm-wiki/work/2026-07-02-y",
        ],
      },
    ]);
  });

  it("retains a canonical non-existent transcript path as a dangling reference candidate", () => {
    const index = collectClaimedTranscripts([
      item({ source: "raw/transcripts/2026-07-01-does-not-exist.md" }),
    ]);
    // No filesystem access here: the well-formed claim is indexed and the
    // command-layer audit decides whether the path is dangling.
    expect(index.claimedByPath.get("raw/transcripts/2026-07-01-does-not-exist.md")).toBe(
      "projects/llm-wiki/work/2026-07-01-x",
    );
    expect(index.diagnostics).toEqual([]);
  });
});
