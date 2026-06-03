import { describe, it, expect } from "vitest";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const CODEX_PLUGIN_ROOT = join(__dirname, "..", "..", "..", "codex-skills");
const CANONICAL_CODEX_PLUGIN_MANIFEST = join(SKILLS_DIR, ".codex-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST = join(CODEX_PLUGIN_ROOT, ".codex-plugin", "plugin.json");
const MARKETPLACE = join(__dirname, "..", "..", "..", "..", ".agents", "plugins", "marketplace.json");
const ALL = [
  "wiki-init", "wiki-ingest", "wiki-query", "wiki-lint", "wiki-crystallize", "wiki-audit",
  "proj-init", "proj-work", "proj-distill", "proj-decide"
];

function listTopLevelSkills(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(join(SKILLS_DIR, name, "SKILL.md")))
    .sort();
}

function expectNotSymlink(path: string): void {
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
}

describe("SKILL.md structure", () => {
  it.each(ALL)("%s has frontmatter with name + description", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/\nname: /);
    expect(text).toMatch(/\ndescription: /);
  });

  it.each(ALL)("%s declares pre-orientation expectations", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(text).toMatch(/Pre-orientation reads/);
  });

  it.each(ALL)("%s declares stop conditions", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(text).toMatch(/Stop conditions/);
  });

  it("Codex marketplace points at the Codex-native plugin root", () => {
    const marketplace = JSON.parse(readFileSync(MARKETPLACE, "utf8"));
    const plugin = marketplace.plugins.find((entry: { name?: string }) => entry.name === "skillwiki");

    expect(plugin?.source?.path).toBe("./packages/codex-skills");
    expect(existsSync(join(CODEX_PLUGIN_ROOT, "hooks", "hooks.json"))).toBe(false);
    expect(existsSync(join(CODEX_PLUGIN_ROOT, "hooks", "hooks-codex.json"))).toBe(true);
    expect(existsSync(join(CODEX_PLUGIN_ROOT, "hooks", "session-start-codex"))).toBe(true);

    expectNotSymlink(join(CODEX_PLUGIN_ROOT, ".codex-plugin"));
    expectNotSymlink(join(CODEX_PLUGIN_ROOT, "skills"));
    expectNotSymlink(join(CODEX_PLUGIN_ROOT, "hooks", "hooks-codex.json"));
    expectNotSymlink(join(CODEX_PLUGIN_ROOT, "hooks", "run-hook.cmd"));
    expectNotSymlink(join(CODEX_PLUGIN_ROOT, "hooks", "session-context"));
    expectNotSymlink(join(CODEX_PLUGIN_ROOT, "hooks", "session-start-codex"));
  });

  it("Codex plugin manifest points at skills and native hooks", () => {
    const manifest = JSON.parse(readFileSync(CODEX_PLUGIN_MANIFEST, "utf8"));

    expect(manifest.skills).toBe("./skills/");
    expect(manifest.hooks).toBe("./hooks/hooks-codex.json");
    expect(readFileSync(CODEX_PLUGIN_MANIFEST, "utf8")).toBe(readFileSync(CANONICAL_CODEX_PLUGIN_MANIFEST, "utf8"));
  });

  it("Codex skills subtree mirrors every canonical top-level skill", () => {
    const canonicalSkills = listTopLevelSkills();
    const codexSkillsDir = join(CODEX_PLUGIN_ROOT, "skills");
    const codexSkills = readdirSync(codexSkillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => existsSync(join(codexSkillsDir, name, "SKILL.md")))
      .sort();

    expect(codexSkills).toEqual(canonicalSkills);

    for (const skill of canonicalSkills) {
      const canonical = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      const codex = readFileSync(join(codexSkillsDir, skill, "SKILL.md"), "utf8");
      expect(codex).toBe(canonical);
    }
  });
});
