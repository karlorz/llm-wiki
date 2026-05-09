import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const ALL = [
  "wiki-init", "wiki-ingest", "wiki-query", "wiki-lint", "wiki-crystallize", "wiki-audit",
  "proj-init", "proj-work", "proj-distill", "proj-decide"
];

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
});
