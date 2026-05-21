import { describe, it, expect } from "vitest";
import { parseExpiryAnnotations } from "../../src/parsers/expiry-annotations.js";

describe("parseExpiryAnnotations", () => {
  it("parses single expires annotation", () => {
    const input = "## Trending Tools\n<!-- expires: 2026-05-28 -->\nSome content";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toEqual([{
      page: "concepts/test.md",
      heading: "Trending Tools",
      line: 2,
      expires: "2026-05-28",
      refresh: undefined,
      source: undefined,
    }]);
  });

  it("parses expires + refresh + source annotation", () => {
    const input = "## Stars\n<!-- expires: 2026-05-28 refresh: weekly source: https://github.com/trending -->\nData";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toEqual([{
      page: "concepts/test.md",
      heading: "Stars",
      line: 2,
      expires: "2026-05-28",
      refresh: "weekly",
      source: "https://github.com/trending",
    }]);
  });

  it("parses multiple annotations across sections", () => {
    const input = "## Section A\n<!-- expires: 2026-06-01 -->\nContent\n\n## Section B\n<!-- expires: 2026-07-01 refresh: monthly -->\nMore";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toHaveLength(2);
    expect(result[0]!.heading).toBe("Section A");
    expect(result[1]!.heading).toBe("Section B");
    expect(result[1]!.refresh).toBe("monthly");
  });

  it("returns empty array when no annotations found", () => {
    const input = "## Plain Section\nNo expiry info here";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toEqual([]);
  });

  it("ignores annotations not immediately after a heading", () => {
    const input = "Some text\n<!-- expires: 2026-05-28 -->\nNot after heading";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toEqual([]);
  });

  it("skips invalid date formats", () => {
    const input = "## Bad Date\n<!-- expires: not-a-date -->\nContent";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toEqual([]);
  });

  it("handles source URLs with query parameters", () => {
    const input = "## Trending\n<!-- expires: 2026-06-01 source: https://github.com/trending?since=weekly -->\nData";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("https://github.com/trending?since=weekly");
  });

  it("handles expires with refresh but no source", () => {
    const input = "## Stats\n<!-- expires: 2026-06-01 refresh: monthly -->\nData";
    const result = parseExpiryAnnotations(input, "concepts/test.md");
    expect(result).toHaveLength(1);
    expect(result[0]!.refresh).toBe("monthly");
    expect(result[0]!.source).toBeUndefined();
  });
});
