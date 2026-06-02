import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const CODEX_PLUGIN_MANIFEST = join(SKILLS_DIR, ".codex-plugin", "plugin.json");
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

  it("Codex plugin manifest points at the conventional skills subtree", () => {
    const manifest = JSON.parse(readFileSync(CODEX_PLUGIN_MANIFEST, "utf8"));

    expect(manifest.skills).toBe("./skills/");
  });

  it("Codex skills subtree mirrors every canonical top-level skill", () => {
    const canonicalSkills = listTopLevelSkills();
    const codexSkillsDir = join(SKILLS_DIR, "skills");
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
