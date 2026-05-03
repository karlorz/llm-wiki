import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenvFile } from "../../src/utils/dotenv.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "dotenv-")); }

describe("parseDotenvFile", () => {
  it("returns empty map when file is missing", async () => {
    const r = await parseDotenvFile(join(tmp(), "missing.env"));
    expect(r).toEqual({});
  });

  it("parses WIKI_PATH and WIKI_LANG", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "WIKI_PATH=/abs/path\nWIKI_LANG=zh-Hant\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/abs/path", WIKI_LANG: "zh-Hant" });
  });

  it("ignores blanks and comment lines", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "\n# comment\nWIKI_PATH=/x\n\n# another\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/x" });
  });

  it("drops keys not in the whitelist", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "WIKI_PATH=/x\nFOO=bar\nBAZ=qux\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/x" });
  });

  it("does not throw on malformed lines (silently skips)", async () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "no-equals-here\nWIKI_PATH=/x\n=missing-key\n");
    expect(await parseDotenvFile(p)).toEqual({ WIKI_PATH: "/x" });
  });
});
