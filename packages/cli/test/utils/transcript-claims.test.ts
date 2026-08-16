import { describe, it, expect } from "vitest";
import {
  collectClaimedTranscripts,
  normalizeRawTranscriptRef,
  REDACTED_MALFORMED_REFERENCE,
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

  it("rejects a multiline raw-transcript scalar even when it ends in .md", () => {
    // A literal block scalar reconstructed by js-yaml can start raw/transcripts/
    // and end .md while embedding an embedded newline. It must never normalize
    // into a canonical claimed path.
    expect(
      normalizeRawTranscriptRef("raw/transcripts/2026-07-01-task-a.md\nsecret=leaked.md"),
    ).toBeUndefined();
  });

  it("rejects raw-transcript scalars containing Unicode line/paragraph separators even when they end in .md", () => {
    expect(
      normalizeRawTranscriptRef("raw/transcripts/2026-07-01-task-b.md\u2028secret.md"),
    ).toBeUndefined();
    expect(
      normalizeRawTranscriptRef("raw/transcripts/2026-07-01-task-c.md\u2029secret.md"),
    ).toBeUndefined();
  });

  it("rejects raw-transcript scalars containing C1 control characters even when they end in .md", () => {
    expect(
      normalizeRawTranscriptRef("raw/transcripts/2026-07-01-task-d.md\u0085secret.md"),
    ).toBeUndefined();
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

  it("redacts malformed attempted references that embed control characters or newlines", () => {
    const multiline = "raw/transcripts/2026-07-01-secret.txt\napi_key=supersecretvalue";
    const crlf = "raw\\transcripts\\2026-07-01-a.md\r\npassword=hunter2";
    const index = collectClaimedTranscripts([
      item({ source: multiline }),
      item({ relDir: "projects/llm-wiki/work/2026-07-02-y", closes: crlf }),
    ]);
    expect(index.claimedByPath.size).toBe(0);
    expect(index.diagnostics).toEqual([
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-01-x",
        field: "source",
        value: REDACTED_MALFORMED_REFERENCE,
      },
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-02-y",
        field: "closes",
        value: REDACTED_MALFORMED_REFERENCE,
      },
    ]);
  });

  it("treats separator-laden attempted refs as malformed and redacts them, never as claims", () => {
    const multilineEndingMd = "raw/transcripts/2026-07-01-task-a.md\npayload.md";
    const unicodeLs = "raw/transcripts/2026-07-01-task-b.md\u2028payload.md";
    const unicodePs = "raw/transcripts/2026-07-01-task-c.md\u2029payload.md";
    const nel = "raw\\transcripts\\2026-07-01-task-d.md\u0085payload.md";
    const index = collectClaimedTranscripts([
      item({ source: multilineEndingMd }),
      item({ relDir: "projects/llm-wiki/work/2026-07-02-y", closes: unicodeLs }),
      item({ relDir: "projects/llm-wiki/work/2026-07-03-z", sources: [unicodePs] }),
      item({ relDir: "projects/llm-wiki/work/2026-07-04-w", closes: nel }),
    ]);
    // None of these may ever become a claimed path.
    expect(index.claimedByPath.size).toBe(0);
    expect(index.diagnostics).toEqual([
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-01-x",
        field: "source",
        value: REDACTED_MALFORMED_REFERENCE,
      },
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-02-y",
        field: "closes",
        value: REDACTED_MALFORMED_REFERENCE,
      },
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-03-z",
        field: "sources",
        value: REDACTED_MALFORMED_REFERENCE,
      },
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-04-w",
        field: "closes",
        value: REDACTED_MALFORMED_REFERENCE,
      },
    ]);
  });

  it("redacts oversized single-line attempted references to bound output", () => {
    const long = "raw/transcripts/" + "x".repeat(2000) + ".txt";
    const index = collectClaimedTranscripts([item({ source: long })]);
    expect(index.claimedByPath.size).toBe(0);
    expect(index.diagnostics).toEqual([
      {
        kind: "malformed",
        relDir: "projects/llm-wiki/work/2026-07-01-x",
        field: "source",
        value: REDACTED_MALFORMED_REFERENCE,
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
