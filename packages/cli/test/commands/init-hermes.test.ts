import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";

const TEMPLATES = join(__dirname, "..", "..", "templates");

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("Hermes wire-compat (rendered vault)", () => {
  it("SCHEMA.md retains the section headers Hermes v2.1.0 references", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "Hermes wire compat", taxonomy: undefined, lang: "en", force: false
    });
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    for (const header of ["## Domain", "## Tag Taxonomy", "## Page Thresholds", "## Update Policy", "## Conventions", "## Layers", "## Frontmatter"]) {
      expect(schema).toContain(header);
    }
    expect(schema).toContain("## Output Language");
  });

  it("index.md retains the structural section names Hermes prompts expect", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    const idx = readFileSync(join(target, "index.md"), "utf8");
    for (const section of ["## Entities", "## Concepts", "## Comparisons", "## Queries", "## Projects", "## Meta"]) {
      expect(idx).toContain(section);
    }
  });

  it("log.md emits the structured `## [YYYY-MM-DD] action |` line shape", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "X", taxonomy: undefined, lang: undefined, force: false
    });
    const log = readFileSync(join(target, "log.md"), "utf8");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] create \| Wiki initialized$/m);
  });

  it("structural elements remain English even with WIKI_LANG=zh-Hant", async () => {
    const h = home();
    const target = mkdtempSync(join(tmpdir(), "wc-"));
    await runInit({
      flag: target, envValue: undefined, home: h, templates: TEMPLATES,
      domain: "中文 domain", taxonomy: undefined, lang: "chinese-traditional", force: false
    });
    const schema = readFileSync(join(target, "SCHEMA.md"), "utf8");
    expect(schema).toContain("## Domain");
    expect(schema).toContain("## Tag Taxonomy");
    const idx = readFileSync(join(target, "index.md"), "utf8");
    expect(idx).toContain("## Entities");
    const log = readFileSync(join(target, "log.md"), "utf8");
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] create \| Wiki initialized$/m);
  });
});
