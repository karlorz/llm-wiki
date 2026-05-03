import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigGet, runConfigSet, runConfigList, runConfigPath } from "../../src/commands/config.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runConfigGet", () => {
  it("returns value when key is set", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/my/vault\n");
    const r = await runConfigGet({ key: "WIKI_PATH", home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.key).toBe("WIKI_PATH");
      expect(r.result.data.value).toBe("/my/vault");
    }
  });

  it("returns empty value when key is not set", async () => {
    const h = home();
    const r = await runConfigGet({ key: "WIKI_LANG", home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.key).toBe("WIKI_LANG");
      expect(r.result.data.value).toBe("");
    }
  });

  it("rejects invalid key with exit 26", async () => {
    const h = home();
    const r = await runConfigGet({ key: "BAD_KEY", home: h });
    expect(r.exitCode).toBe(26);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("INVALID_CONFIG_KEY");
  });
});

describe("runConfigSet", () => {
  it("writes a new key to existing file", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/old\n");
    const r = await runConfigSet({ key: "WIKI_PATH", value: "/new", home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.key).toBe("WIKI_PATH");
      expect(r.result.data.value).toBe("/new");
      expect(r.result.data.written).toBe(true);
    }
    const text = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(text).toContain("WIKI_PATH=/new");
    expect(text).not.toContain("WIKI_PATH=/old");
  });

  it("creates .skillwiki/.env when it does not exist", async () => {
    const h = home();
    const r = await runConfigSet({ key: "WIKI_PATH", value: "/fresh", home: h });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(h, ".skillwiki", ".env"))).toBe(true);
  });

  it("rejects invalid key with exit 26", async () => {
    const h = home();
    const r = await runConfigSet({ key: "INVALID", value: "x", home: h });
    expect(r.exitCode).toBe(26);
    expect(r.result.ok).toBe(false);
  });
});

describe("runConfigList", () => {
  it("returns all key-value pairs", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/v\nWIKI_LANG=ja\n");
    const r = await runConfigList({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries).toEqual([
        { key: "WIKI_PATH", value: "/v" },
        { key: "WIKI_LANG", value: "ja" }
      ]);
    }
  });

  it("returns empty entries when no config file exists", async () => {
    const h = home();
    const r = await runConfigList({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries).toEqual([]);
    }
  });
});

describe("runConfigPath", () => {
  it("returns path and exists=true when file present", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/v\n");
    const r = await runConfigPath({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(join(h, ".skillwiki", ".env"));
      expect(r.result.data.exists).toBe(true);
    }
  });

  it("returns path and exists=false when file absent", async () => {
    const h = home();
    const r = await runConfigPath({ home: h });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(join(h, ".skillwiki", ".env"));
      expect(r.result.data.exists).toBe(false);
    }
  });
});
