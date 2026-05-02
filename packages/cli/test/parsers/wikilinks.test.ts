import { describe, it, expect } from "vitest";
import { extractBodyWikilinks } from "../../src/parsers/wikilinks.js";

describe("wikilinks", () => {
  it("finds plain wikilinks in body text", () => {
    expect(extractBodyWikilinks("see [[foo]] and [[bar/baz]]")).toEqual(["foo", "bar/baz"]);
  });
  it("ignores escaped or code-fenced links", () => {
    expect(extractBodyWikilinks("`[[code]]`\n[[real]]")).toEqual(["real"]);
  });
  it("handles aliased wikilinks [[target|display]]", () => {
    expect(extractBodyWikilinks("[[target|alias]]")).toEqual(["target"]);
  });
  it("dedupes within a single body", () => {
    expect(extractBodyWikilinks("[[a]] and [[a]] again")).toEqual(["a"]);
  });
});
