import { describe, it, expect } from "vitest";
import { extractCitationMarkers, hasSourcesFooter, isLegacyCitationStyle, extractParagraphEndCitations } from "../../src/parsers/citations.js";

describe("extractCitationMarkers", () => {
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

describe("hasSourcesFooter", () => {
  it("returns true when ## Sources heading exists", () => {
    expect(hasSourcesFooter("Body text.\n\n## Sources\n- ^[raw/x.md]\n")).toBe(true);
  });
  it("returns false when no ## Sources heading", () => {
    expect(hasSourcesFooter("Body text.\n^[raw/x.md]\n")).toBe(false);
  });
  it("ignores ## Sources inside code fences", () => {
    expect(hasSourcesFooter("Body\n```\n## Sources\n```\n")).toBe(false);
  });
});

describe("isLegacyCitationStyle", () => {
  it("returns false for body with no markers", () => {
    expect(isLegacyCitationStyle("Plain body text.")).toBe(false);
  });
  it("returns true for marker-only lines without footer", () => {
    expect(isLegacyCitationStyle("Body cites X.\n^[raw/x.md]\nBody cites Y.\n^[raw/y.md]")).toBe(true);
  });
  it("returns false for paragraph-end markers with footer", () => {
    const body = "Body cites X. ^[raw/x.md]\n\nBody cites Y. ^[raw/y.md]\n\n## Sources\n- ^[raw/x.md]\n- ^[raw/y.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
  });
  it("returns true when footer exists but markers are mid-line", () => {
    const body = "Body cites ^[raw/x.md] in the middle.\n\n## Sources\n- ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(true);
  });
  it("returns true when markers at paragraph-end but no footer", () => {
    expect(isLegacyCitationStyle("Body cites X. ^[raw/x.md]\n")).toBe(true);
  });
  it("returns true when markers are on their own line with footer", () => {
    const body = "Body cites X.\n^[raw/x.md]\n\n## Sources\n- ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(true);
  });
});

describe("extractParagraphEndCitations", () => {
  it("extracts markers on the same line as sentence text", () => {
    const body = "Body cites X. ^[raw/x.md]\n\nBody cites Y. ^[raw/y.md]\n";
    expect(extractParagraphEndCitations(body)).toEqual(["raw/x.md", "raw/y.md"]);
  });
  it("returns empty for marker-only lines (legacy style)", () => {
    expect(extractParagraphEndCitations("Body.\n^[raw/x.md]\n")).toEqual([]);
  });
  it("returns empty for inline (mid-line) markers", () => {
    expect(extractParagraphEndCitations("Body cites ^[raw/x.md] in middle.\n")).toEqual([]);
  });
  it("ignores markers inside code fences", () => {
    const body = "```\nBody. ^[raw/x.md]\n```\n\nReal. ^[raw/y.md]\n";
    expect(extractParagraphEndCitations(body)).toEqual(["raw/y.md"]);
  });
});
