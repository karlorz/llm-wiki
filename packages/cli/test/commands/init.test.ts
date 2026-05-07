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

/** Create a vault target in the system temp dir.
 *  The isTempPath heuristic was removed — vaults under /tmp/ now write .env normally. */
function vault(): string { return tmp(); }

describe("runInit", () => {
  it("creates the vault tree, SCHEMA.md, index.md, log.md and writes both env keys", async () => {
    const h = home();
    const target = vault();
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
                        "entities", "concepts", "comparisons", "queries", "meta", "projects",
                        ".obsidian", "_Templates"]) {
      expect(statSync(join(target, dir)).isDirectory()).toBe(true);
    }
    const obsidianConfig = JSON.parse(readFileSync(join(target, ".obsidian", "app.json"), "utf8"));
    expect(obsidianConfig.attachmentFolderPath).toBe("raw/assets");
    const templatesConfig = JSON.parse(readFileSync(join(target, ".obsidian", "templates.json"), "utf8"));
    expect(templatesConfig.folder).toBe("_Templates");
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
    const target = vault();
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
    const target = vault();
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
    const target = vault();
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

  it("writes env file when target is under /tmp (no implicit skip)", async () => {
    const h = home();
    const target = "/tmp/skillwiki-test-" + Date.now();
    mkdirSync(target, { recursive: true });
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false, noEnv: false
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.env_written).toBe(join(h, ".skillwiki", ".env"));
      expect(r.result.data.env_skipped).toBe(false);
    }
  });

  it("--force preserves existing index.md when it has >10 lines", async () => {
    const h = home();
    const target = tmp();
    const bigIndex = Array.from({ length: 25 }, (_, i) => `- [[page-${i}]] — page ${i}`).join("\n");
    writeFileSync(join(target, "SCHEMA.md"), "# Old\n");
    writeFileSync(join(target, "index.md"), "# Index\n\n" + bigIndex + "\n");
    writeFileSync(join(target, "log.md"), "# Log\n" + "## [2026-01-01] test\n".repeat(15));
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.preserved).toContain("index.md");
    if (r.result.ok) expect(r.result.data.preserved).toContain("log.md");
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toContain("page-0");
    expect(idx).not.toContain("Total pages: 0");
  });

  it("--force overwrites empty index.md and log.md", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), "# Old\n");
    writeFileSync(join(target, "index.md"), "");
    writeFileSync(join(target, "log.md"), "");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.preserved).not.toContain("index.md");
    if (r.result.ok) expect(r.result.data.preserved).not.toContain("log.md");
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toContain("Total pages: 0");
  });

  it("--force migrates existing hermes SCHEMA.md (domain preserved, taxonomy merged)", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), `# Wiki Schema

## Domain
Finance and markets knowledge base — HK/Asia, US, commodities.

## Conventions
- File names: lowercase, hyphens, no spaces
- Use [[wikilinks]] for cross-references

## Tag Taxonomy
- markets, macro, central-bank, earnings, commodity, crypto, forex
`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.domain).toBe("Finance and markets knowledge base — HK/Asia, US, commodities.");
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("Finance and markets");
    expect(schema).toContain("## Output Language");
    expect(schema).toContain("## Layers");
  });

  it("--force discovers taxonomy from existing page tags", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), `# Vault Schema\n\n## Domain\nTest\n`);
    mkdirSync(join(target, "concepts"), { recursive: true });
    mkdirSync(join(target, "entities"), { recursive: true });
    mkdirSync(join(target, "raw"), { recursive: true });
    writeFileSync(join(target, "concepts", "oil.md"),
      `---\ntitle: Oil\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: concept\ntags: [oil, energy, commodity]\nsources: []\n---\n\n# Oil\n`);
    writeFileSync(join(target, "entities", "fed.md"),
      `---\ntitle: Fed\ncreated: 2026-01-01\nupdated: 2026-01-01\ntype: entity\ntags: [central-bank, fed, usd]\nsources: []\n---\n\n# Fed\n`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Test", taxonomy: ["oil", "commodity"], lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.discovered_tags).toBeGreaterThan(0);
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("- energy");
    expect(schema).toContain("- central-bank");
    expect(schema).toContain("- fed");
    expect(schema).toContain("- usd");
    expect(schema).toContain("Discovered from existing pages");
    expect(schema).toContain("- oil");
    expect(schema).toContain("- commodity");
  });

  it("--profile writes WIKI_{NAME}_PATH instead of WIKI_PATH", async () => {
    const h = home();
    const target = vault();
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Finance", taxonomy: undefined, lang: undefined, force: false,
      profile: "finance"
    });
    expect(r.exitCode).toBe(0);
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_FINANCE_PATH=${target}`);
    expect(env).toContain("WIKI_FINANCE_LANG=en");
    expect(env).toContain("WIKI_DEFAULT=finance");
    expect(env).not.toMatch(/^WIKI_PATH=/m);
    expect(env).not.toMatch(/^WIKI_LANG=/m);
  });

  it("--profile does not trigger ENV_WRITE_CONFLICT with existing WIKI_PATH", async () => {
    const h = home();
    const target = vault();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/other/path\nWIKI_LANG=en\n");
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false,
      profile: "work"
    });
    expect(r.exitCode).toBe(0);
    const env = readFileSync(join(h, ".skillwiki", ".env"), "utf8");
    expect(env).toContain(`WIKI_WORK_PATH=${target}`);
    expect(env).toContain("WIKI_DEFAULT=work");
    expect(env).toContain("WIKI_PATH=/other/path");
  });

  it("--domain flag overrides old domain when both provided", async () => {
    const h = home();
    const target = tmp();
    writeFileSync(join(target, "SCHEMA.md"), `# Vault Schema\n\n## Domain\nOld domain text\n`);
    const r = await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "New domain override", taxonomy: undefined, lang: undefined, force: true, noEnv: true
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.domain).toBe("New domain override");
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("New domain override");
    expect(schema).not.toContain("Old domain text");
  });
});
