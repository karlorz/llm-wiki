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

  it("returns empty array when body has no wikilinks", () => {
    expect(extractBodyWikilinks("just plain text\nno links here")).toEqual([]);
  });

  it("trims whitespace from wikilink targets", () => {
    expect(extractBodyWikilinks("[[ foo ]] and [[bar ]]\n")).toEqual(["foo", "bar"]);
  });

  it("ignores wikilinks inside triple-backtick fenced code blocks", () => {
    const body = "```\n[[inside-fence]]\n```\n[[outside]]\n";
    expect(extractBodyWikilinks(body)).toEqual(["outside"]);
  });
});
