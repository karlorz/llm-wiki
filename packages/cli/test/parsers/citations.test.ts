import { describe, it, expect } from "vitest";
import { extractCitationMarkers, hasSourcesFooter, isLegacyCitationStyle, extractParagraphEndCitations, hasOrphanedCitations, hasWikilinkCitations } from "../../src/parsers/citations.js";

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
  it("ignores markers inside inline code spans", () => {
    const body = "Use `^[raw/x.md]` for citations. ^[raw/y.md]\n";
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
  it("ignores markers inside inline code spans", () => {
    const body = "Use `^[raw/x.md]` for citations.\n\n## Sources\n- ^[raw/y.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
  });
  it("returns false when inline code near ## Sources (backtick bug)", () => {
    // Regression: inline code stripping used to eat the ## Sources header
    const body = "Exit code is 22 (warnings). `--human` flag shows output. ^[raw/x.md]\n\n## Sources\n- ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
  });
  it("returns true when truly missing ## Sources even with inline code", () => {
    const body = "Use `--flag` for output. ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(true);
  });
  it("ignores markers inside double-backtick inline code spans", () => {
    // Regression: ``^[raw/x.md]`` double-backtick spans were not stripped
    const body = "Use ``^[raw/x.md]`` for citations. ^[raw/y.md]\n\n## Sources\n- ^[raw/y.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
  });
  it("ignores partial ^[raw/ in prose after stripping inline code", () => {
    // Regression: adjacent inline code spans left bare ^[raw/] fragments
    // e.g. `[[raw/...]]` and `` `` stripping left ^[raw/] in the line
    const body = "Pages with `sources:` frontmatter using `[[raw/...]]` wikilinks. `` body citations.\n\n## Sources\n- ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
  });
  it("allows marker-only line after a table row", () => {
    // Tables can't hold inline citations — a bare marker after | rows is valid
    const body = "Some claim. ^[raw/x.md]\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n^[raw/x.md]\n\n## Sources\n- ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
  });
  it("ignores citation markers in YAML frontmatter", () => {
    // Regression: frontmatter sources: field contains ^[raw/...] that was parsed as body text
    const body = "---\nname: test\nsources:\n  - \"^[raw/x.md]\"\n---\n\nSome claim. ^[raw/x.md]\n\n## Sources\n- ^[raw/x.md]\n";
    expect(isLegacyCitationStyle(body)).toBe(false);
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

describe("hasOrphanedCitations", () => {
  it("returns false for no markers", () => {
    expect(hasOrphanedCitations("Plain body text.\n\n## Sources\n")).toBe(false);
  });
  it("returns false for valid Sources section", () => {
    const body = "Body cites X. ^[raw/x.md]\n\n## Sources\n- ^[raw/x.md]\n";
    expect(hasOrphanedCitations(body)).toBe(false);
  });
  it("returns true for marker after blank line in Sources", () => {
    const body = "Body.\n\n## Sources\n- ^[raw/x.md]\n\n\n^[raw/x.md]\n";
    expect(hasOrphanedCitations(body)).toBe(true);
  });
  it("returns true for marker after non-list content in Sources", () => {
    const body = "Body.\n\n## Sources\n- ^[raw/x.md]\nSome text\n^[raw/y.md]\n";
    expect(hasOrphanedCitations(body)).toBe(true);
  });
  it("returns false when no Sources section", () => {
    const body = "Body. ^[raw/x.md]\n";
    expect(hasOrphanedCitations(body)).toBe(false);
  });
  it("returns false for multiple valid list items", () => {
    const body = "Body.\n\n## Sources\n- ^[raw/x.md]\n- ^[raw/y.md]\n- ^[raw/z.md]\n";
    expect(hasOrphanedCitations(body)).toBe(false);
  });
  it("ignores markers inside code fences", () => {
    const body = "Body.\n\n## Sources\n- ^[raw/x.md]\n\n```\n^[raw/y.md]\n```\n";
    expect(hasOrphanedCitations(body)).toBe(false);
  });
});

describe("hasWikilinkCitations", () => {
  it("returns true for [[raw/...]] wikilinks in body", () => {
    expect(hasWikilinkCitations("Cites source [[raw/articles/foo.md]].\n")).toBe(true);
  });
  it("returns false for ^[raw/...] citations", () => {
    expect(hasWikilinkCitations("Cites source. ^[raw/articles/foo.md]\n")).toBe(false);
  });
  it("returns false for plain text", () => {
    expect(hasWikilinkCitations("Plain body text.\n")).toBe(false);
  });
  it("ignores [[raw/...]] inside code fences", () => {
    expect(hasWikilinkCitations("```\n[[raw/articles/foo.md]]\n```\n")).toBe(false);
  });
});
