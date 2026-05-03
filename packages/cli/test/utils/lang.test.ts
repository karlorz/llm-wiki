import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLang, resolveLang } from "../../src/utils/lang.js";

function tmpHome(): string {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".skillwiki"), { recursive: true });
  return home;
}

describe("normalizeLang", () => {
  it("returns 'en' for english/en (any case)", () => {
    expect(normalizeLang("english")).toBe("en");
    expect(normalizeLang("EN")).toBe("en");
    expect(normalizeLang("  en  ")).toBe("en");
  });
  it("normalizes Traditional Chinese aliases to zh-Hant", () => {
    for (const a of ["chinese-traditional", "ZH-HANT", "zh-tw", "Chinese-Traditional"]) {
      expect(normalizeLang(a)).toBe("zh-Hant");
    }
  });
  it("normalizes Simplified Chinese aliases to zh-Hans", () => {
    for (const a of ["chinese-simplified", "ZH-HANS", "zh-cn"]) {
      expect(normalizeLang(a)).toBe("zh-Hans");
    }
  });
  it("passes unknown tags through verbatim (trimmed)", () => {
    expect(normalizeLang("  fr-CA  ")).toBe("fr-CA");
  });
});

describe("resolveLang", () => {
  it("flag beats env beats dotenv beats default", async () => {
    const home = tmpHome();
    writeFileSync(join(home, ".skillwiki", ".env"), "WIKI_LANG=zh-Hant\n");

    expect(await resolveLang({ flag: "ja", envValue: "fr", home })).toEqual({
      value: "ja", source: "flag", canonical: "ja"
    });
    expect(await resolveLang({ flag: undefined, envValue: "fr", home })).toEqual({
      value: "fr", source: "env", canonical: "fr"
    });
    expect(await resolveLang({ flag: undefined, envValue: undefined, home })).toEqual({
      value: "zh-Hant", source: "skillwiki-dotenv", canonical: "zh-Hant"
    });
  });

  it("falls back to 'en' default when no source supplies a value", async () => {
    const home = tmpHome();
    expect(await resolveLang({ flag: undefined, envValue: undefined, home })).toEqual({
      value: "en", source: "default", canonical: "en"
    });
  });

  it("normalizes the chosen value (chinese-traditional → zh-Hant)", async () => {
    const home = tmpHome();
    expect(await resolveLang({ flag: "chinese-traditional", envValue: undefined, home })).toEqual({
      value: "chinese-traditional", source: "flag", canonical: "zh-Hant"
    });
  });
});
