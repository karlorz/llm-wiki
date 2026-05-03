import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotenvFile, writeDotenv } from "../../src/utils/dotenv.js";

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

describe("writeDotenv", () => {
  it("creates a new file with the given entries", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    await writeDotenv(filePath, { WIKI_PATH: "/my/vault" }, undefined);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("WIKI_PATH=/my/vault");
  });

  it("creates parent directories if missing", async () => {
    const dir = tmp();
    const filePath = join(dir, "sub", "dir", ".env");
    await writeDotenv(filePath, { WIKI_LANG: "zh" }, undefined);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("WIKI_LANG=zh");
  });

  it("updates an existing key while preserving comments and blank lines", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    const original = "# my config\nWIKI_PATH=/old\n\nWIKI_LANG=en\n";
    writeFileSync(filePath, original);
    await writeDotenv(filePath, { WIKI_PATH: "/new" }, original);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("WIKI_PATH=/new");
    expect(text).not.toContain("WIKI_PATH=/old");
    expect(text).toContain("WIKI_LANG=en");
  });

  it("appends a new key to an existing file", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    const original = "WIKI_PATH=/vault\n";
    writeFileSync(filePath, original);
    await writeDotenv(filePath, { WIKI_LANG: "ja" }, original);
    const text = readFileSync(filePath, "utf8");
    expect(text).toContain("WIKI_PATH=/vault");
    expect(text).toContain("WIKI_LANG=ja");
  });

  it("round-trips through parseDotenvFile", async () => {
    const dir = tmp();
    const filePath = join(dir, ".env");
    await writeDotenv(filePath, { WIKI_PATH: "/rt", WIKI_LANG: "de" }, undefined);
    const parsed = await parseDotenvFile(filePath);
    expect(parsed).toEqual({ WIKI_PATH: "/rt", WIKI_LANG: "de" });
  });
});
