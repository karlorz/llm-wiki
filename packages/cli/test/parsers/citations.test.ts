import { describe, it, expect } from "vitest";
import { extractCitationMarkers } from "../../src/parsers/citations.js";

describe("citations", () => {
  it("finds ^[raw/...] markers", () => {
    const body = "Claim X.\n^[raw/articles/foo.md]\nClaim Y.\n^[raw/papers/bar.md]\n";
    expect(extractCitationMarkers(body)).toEqual([
      { marker: "^[raw/articles/foo.md]", target: "raw/articles/foo.md" },
      { marker: "^[raw/papers/bar.md]", target: "raw/papers/bar.md" }
    ]);
  });
  it("ignores markers inside code fences", () => {
    const body = "```\n^[raw/x.md]\n```\n^[raw/y.md]\n";
    expect(extractCitationMarkers(body).map(m => m.target)).toEqual(["raw/y.md"]);
  });
  it("returns empty array when none", () => {
    expect(extractCitationMarkers("plain body")).toEqual([]);
  });
});
