import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLang } from "../../src/commands/lang.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runLang", () => {
  it("returns default 'en' with source=default when nothing supplies a value", async () => {
    const h = home();
    const r = await runLang({ flag: undefined, envValue: undefined, home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.canonical).toBe("en");
      expect(r.result.data.source).toBe("default");
    }
  });

  it("normalizes alias from skillwiki dotenv (chinese-traditional → zh-Hant)", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_LANG=chinese-traditional\n");
    const r = await runLang({ flag: undefined, envValue: undefined, home: h });
    if (r.result.ok) {
      expect(r.result.data.canonical).toBe("zh-Hant");
      expect(r.result.data.source).toBe("skillwiki-dotenv");
    }
  });

  it("--explain returns the chain", async () => {
    const h = home();
    const r = await runLang({ flag: "ja", envValue: undefined, home: h, explain: true });
    if (r.result.ok) {
      expect(Array.isArray(r.result.data.chain)).toBe(true);
    }
  });

  it("resolves 'zh-cn' alias to 'zh-Hans'", async () => {
    const h = home();
    const r = await runLang({ flag: "zh-cn", envValue: undefined, home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.canonical).toBe("zh-Hans");
      expect(r.result.data.source).toBe("flag");
    }
  });

  it("passes through unrecognized language code without canonical normalization", async () => {
    const h = home();
    const r = await runLang({ flag: "xx", envValue: undefined, home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.canonical).toBe("xx");
      expect(r.result.data.source).toBe("flag");
    }
  });
});
