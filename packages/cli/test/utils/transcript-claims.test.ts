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
});
