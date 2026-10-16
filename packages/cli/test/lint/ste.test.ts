import { describe, it, expect } from "vitest";
import {
  comparisonLacksVisual,
  countWords,
  findHedgesOutsideAllowedRegions,
  findLongUnits,
  hasMarkdownTable,
  hasMermaidBlock,
  hasSteHedgeViolation,
  hasSteSentenceLengthViolation,
  isOutputStandardV2,
  mermaidBlocksMissingLeastCertain,
  splitSentences,
  stripUrlsAndCitations,
} from "../../src/lint/ste.js";

describe("STE helpers", () => {
  it("splits sentences on terminal punctuation", () => {
    expect(splitSentences("Short one. Short two!")).toEqual(["Short one.", "Short two!"]);
  });

  it("counts words after stripping URLs and citation markers", () => {
    const text = "See https://example.com/path for the note ^[raw/articles/x.md] today.";
    expect(stripUrlsAndCitations(text)).not.toMatch(/https?:\/\//);
    expect(stripUrlsAndCitations(text)).not.toContain("^[raw/articles/x.md]");
    expect(countWords(text)).toBe(5);
  });

  it("flags prose over 25 words and ordered items over 20 words", () => {
    const longProse = Array.from({ length: 26 }, (_, i) => `w${i + 1}`).join(" ") + ".";
    const longItem = Array.from({ length: 21 }, (_, i) => `s${i + 1}`).join(" ") + ".";
    expect(countWords(longProse)).toBe(26);
    const findings = findLongUnits(`${longProse}\n\n1. ${longItem}\n`);
    expect(findings.some((f) => f.limit === 25)).toBe(true);
    expect(findings.some((f) => f.limit === 20)).toBe(true);
  });

  it("flags unordered items under Steps headings with the 20-word cap", () => {
    const item = Array.from({ length: 21 }, (_, i) => `s${i + 1}`).join(" ") + ".";
    expect(countWords(item)).toBe(21);
    expect(hasSteSentenceLengthViolation(`## Steps\n\n- ${item}\n`)).toBe(true);
    expect(hasSteSentenceLengthViolation(`## Other\n\n- ${item}\n`)).toBe(false);
  });

  it("ignores frontmatter-equivalent regions: headings, fences, tables, quotes, URLs, citations", () => {
    const long = Array.from({ length: 26 }, (_, i) => `w${i + 1}`).join(" ") + ".";
    const body = [
      `## ${long}`,
      "",
      "```",
      long,
      "```",
      "",
      `| ${long} | x |`,
      "| --- | --- |",
      `| ${long} | y |`,
      "",
      `> ${long}`,
      "",
      `See ${"https://example.com/" + "word/".repeat(30)} now.`,
      "",
      `Done ^[raw/articles/${"long-path/".repeat(20)}x.md].`,
    ].join("\n");
    expect(hasSteSentenceLengthViolation(body)).toBe(false);
  });

  it("scans hedges outside Uncertainty and Least certain lists", () => {
    expect(findHedgesOutsideAllowedRegions("This might break.\n")).toEqual(["might"]);
    expect(hasSteHedgeViolation("It appears to work.\n")).toBe(true);
    expect(hasSteHedgeViolation("## Uncertainty\n\nThis might break.\n")).toBe(false);
    expect(hasSteHedgeViolation("**Least certain:**\n- This might break.\n")).toBe(false);
    expect(hasSteHedgeViolation("```\nmight\n```\n")).toBe(false);
    expect(hasSteHedgeViolation("> This might break.\n")).toBe(false);
  });

  it("requires a Least certain list after each mermaid block", () => {
    expect(hasMermaidBlock("```mermaid\nflowchart TD\n  A --> B\n```\n")).toBe(true);
    expect(mermaidBlocksMissingLeastCertain("```mermaid\nflowchart TD\n  A --> B\n```\n")).toBe(true);
    expect(mermaidBlocksMissingLeastCertain(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n**Least certain:**\n- Edge A to B\n"
    )).toBe(false);
  });

  it("detects comparison visuals", () => {
    expect(hasMarkdownTable("| a | b |\n| --- | --- |\n| 1 | 2 |\n")).toBe(true);
    expect(comparisonLacksVisual("No table and no diagram.\n")).toBe(true);
    expect(comparisonLacksVisual("| a | b |\n| --- | --- |\n| 1 | 2 |\n")).toBe(false);
    expect(comparisonLacksVisual("```mermaid\nflowchart TD\n  A --> B\n```\n")).toBe(false);
  });

  it("recognizes the v2 marker", () => {
    expect(isOutputStandardV2({ output_standard: "v2" })).toBe(true);
    expect(isOutputStandardV2({})).toBe(false);
    expect(isOutputStandardV2({ output_standard: "v1" })).toBe(false);
  });
});
