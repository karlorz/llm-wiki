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
  const item = (source?: unknown, closes?: unknown): ClaimIndexSource => ({
    relDir: "projects/llm-wiki/work/2026-07-01-x",
    source,
    closes,
  });

  it("collects exact source references", () => {
    const index = collectClaimedTranscripts([
      item("raw/transcripts/2026-07-01-task-a.md"),
    ]);
    expect(index.claimedPaths.has("raw/transcripts/2026-07-01-task-a.md")).toBe(true);
  });

  it("collects closes as a single value or an array", () => {
    const index = collectClaimedTranscripts([
      item(undefined, "raw/transcripts/2026-07-01-task-b.md"),
      item(undefined, [
        "raw/transcripts/2026-07-01-task-c.md",
        "raw/transcripts/2026-07-01-task-d.md",
      ]),
    ]);
    expect(index.claimedPaths.has("raw/transcripts/2026-07-01-task-b.md")).toBe(true);
    expect(index.claimedPaths.has("raw/transcripts/2026-07-01-task-c.md")).toBe(true);
    expect(index.claimedPaths.has("raw/transcripts/2026-07-01-task-d.md")).toBe(true);
  });

  it("ignores non-path and non-transcript values", () => {
    const index = collectClaimedTranscripts([
      item(42, "raw/articles/2026-07-01-x.md"),
      item("raw/transcripts/../escape.md", ["not a path"]),
    ]);
    expect(index.claimedPaths.size).toBe(0);
  });

  it("deduplicates repeated references", () => {
    const index = collectClaimedTranscripts([
      item("raw/transcripts/2026-07-01-task-a.md"),
      item(undefined, ["raw/transcripts/2026-07-01-task-a.md"]),
    ]);
    expect(index.claimedPaths.size).toBe(1);
  });
});
