import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";

const TEMPLATES = join(__dirname, "..", "..", "templates");

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".hermes"), { recursive: true });
  return h;
}

function tmp(): string { return mkdtempSync(join(tmpdir(), "init-")); }

describe("runInit", () => {
  it("creates the vault tree, SCHEMA.md, index.md, log.md and writes both env keys", async () => {
    const h = home();
    const target = tmp();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "AI safety", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.vault).toBe(target);
      expect(r.result.data.lang).toBe("en");
      expect(r.result.data.imported_from_hermes).toBe(false);
    }
    for (const dir of ["raw/articles", "raw/papers", "raw/transcripts", "raw/assets",
                        "entities", "concepts", "comparisons", "queries", "meta", "projects"]) {
      expect(statSync(join(target, dir)).isDirectory()).toBe(true);
    }
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("AI safety");
    expect(schema).toContain("- research");
    expect(schema).toContain("- model");
    expect(schema).not.toContain("{{DOMAIN}}");
    expect(schema).not.toContain("{{TAXONOMY_YAML}}");
    expect(schema).not.toContain("{{WIKI_LANG}}");
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_PATH=${target}`);
    expect(env).toContain("WIKI_LANG=en");
  });

  it("fails INIT_TARGET_NOT_EMPTY (15) when target already has SCHEMA.md", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), "existing");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(15);
    if (!r.result.ok) expect(r.result.error).toBe("INIT_TARGET_NOT_EMPTY");
  });

  it("--force overrides INIT_TARGET_NOT_EMPTY and re-renders", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), "old");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: true
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(target, "SCHEMA.md"), "utf8")).toContain("# Vault Schema");
  });

  it("normalizes --lang chinese-traditional → zh-Hant in dotenv and JSON", async () => {
    const h = home();
    const target = tmp();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "chinese-traditional", force: false
    });
    if (r.result.ok) expect(r.result.data.lang).toBe("zh-Hant");
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain("WIKI_LANG=zh-Hant");
  });

  it("custom --taxonomy renders YAML body lines", async () => {
    const h = home();
    const target = tmp();
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: ["model", "architecture", "benchmark"], lang: undefined, force: false
    });
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("  - model");
    expect(schema).toContain("  - architecture");
    expect(schema).toContain("  - benchmark");
    expect(schema).not.toContain("- research");
  });

  it("Hermes-import path: target resolved from ~/.hermes/.env, imported_from_hermes=true", async () => {
    const h = home();
    const hermesTarget = tmp();
    writeFileSync(join(h, ".hermes", ".env"), `WIKI_PATH=${hermesTarget}\n`);
    const r = await runInit({
      flag: undefined, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Imported", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.vault).toBe(hermesTarget);
      expect(r.result.data.imported_from_hermes).toBe(true);
    }
  });

  it("Hermes-import is false when ~/.skillwiki/.env already has WIKI_PATH", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${target}\nWIKI_LANG=en\n`);
    const r = await runInit({
      flag: undefined, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    if (r.result.ok) expect(r.result.data.imported_from_hermes).toBe(false);
  });

  it("ENV_WRITE_CONFLICT (24) when ~/.skillwiki/.env already binds a different WIKI_PATH", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/different/path\n");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    expect(r.exitCode).toBe(24);
    if (!r.result.ok) expect(r.result.error).toBe("ENV_WRITE_CONFLICT");
  });

  it("ENV_WRITE_CONFLICT (24) when ~/.skillwiki/.env already binds a different WIKI_LANG", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${target}\nWIKI_LANG=zh-Hant\n`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "ja", force: false
    });
    expect(r.exitCode).toBe(24);
  });

  it("--force overrides ENV_WRITE_CONFLICT and rewrites both keys", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/different/path\nWIKI_LANG=zh-Hant\n");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "ja", force: true
    });
    expect(r.exitCode).toBe(0);
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_PATH=${target}`);
    expect(env).toContain("WIKI_LANG=ja");
    expect(env).not.toContain("WIKI_PATH=/different/path");
    expect(env).not.toContain("WIKI_LANG=zh-Hant");
  });

  it("idempotent on identical values (no error, no diff)", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${target}\nWIKI_LANG=en\n`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: "en", force: false
    });
    expect(r.exitCode).toBe(0);
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_PATH=${target}`);
    expect(env).toContain("WIKI_LANG=en");
  });

  it("templates/log.md substitutes INIT_DATE, DOMAIN, WIKI_LANG", async () => {
    const h = home();
    const target = tmp();
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Quantum", taxonomy: undefined, lang: undefined, force: false
    });
    const log = readFileSync(join(target, "log.md"), "utf8");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] create \| Wiki initialized/m);
    expect(log).toContain("- Domain: Quantum");
    expect(log).toContain("- Output language: en");
  });

  it("templates/index.md substitutes INIT_DATE", async () => {
    const h = home();
    const target = tmp();
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toMatch(/^> Last updated: \d{4}-\d{2}-\d{2} \| Total pages: 0/m);
  });

  it("--no-env skips env file write", async () => {
    const h = home();
    const target = tmp();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.env_written).toBe("");
      expect(r.result.data.env_skipped).toBe(true);
    }
    expect(() => statSync(join(h, ".skillwiki", ".env"))).toThrow();
  });

  it("skips env write when target is under /tmp", async () => {
    const h = home();
    const target = "/tmp/skillwiki-test-" + Date.now();
    mkdirSync(target, { recursive: true });
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false, noEnv: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.env_written).toBe("");
      expect(r.result.data.env_skipped).toBe(true);
    }
  });
});
