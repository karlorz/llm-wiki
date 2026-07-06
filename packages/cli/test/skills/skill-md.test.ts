import { describe, it, expect } from "vitest";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const CODEX_PLUGIN_ROOT = join(__dirname, "..", "..", "..", "codex-skills");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CANONICAL_CODEX_PLUGIN_MANIFEST = join(SKILLS_DIR, ".codex-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST = join(CODEX_PLUGIN_ROOT, ".codex-plugin", "plugin.json");
const MARKETPLACE = join(__dirname, "..", "..", "..", "..", ".agents", "plugins", "marketplace.json");
const ALL = [
  "wiki-init", "wiki-ingest", "wiki-query", "wiki-lint", "wiki-crystallize", "wiki-audit",
  "proj-init", "proj-work", "proj-distill", "proj-decide"
];
const AGENT_SKILLS_FRONTMATTER_FIELDS = new Set([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);

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

function readSkillFrontmatter(skill: string): Record<string, unknown> {
  const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match, `${skill} must start with YAML frontmatter`).not.toBeNull();
  return yaml.load(match![1]) as Record<string, unknown>;
}

describe("SKILL.md structure", () => {
  it.each(ALL)("%s has frontmatter with name + description", (skill) => {
    const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toMatch(/\nname: /);
    expect(text).toMatch(/\ndescription: /);
  });

  it("all canonical skill frontmatter uses Agent Skills schema fields", () => {
    for (const skill of listTopLevelSkills()) {
      const frontmatter = readSkillFrontmatter(skill);
      const keys = Object.keys(frontmatter).sort();
      const unexpected = keys.filter(key => !AGENT_SKILLS_FRONTMATTER_FIELDS.has(key));

      expect(frontmatter.name, `${skill} name must match directory`).toBe(skill);
      expect(typeof frontmatter.description, `${skill} description must be a string`).toBe("string");
      expect((frontmatter.description as string).length, `${skill} description must not be empty`).toBeGreaterThan(0);
      expect(unexpected, `${skill} has unsupported frontmatter keys`).toEqual([]);
    }
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

  it("using-skillwiki keeps plugin-managed skill refresh guidance explicit", () => {
    const text = readFileSync(join(SKILLS_DIR, "using-skillwiki", "SKILL.md"), "utf8");

    expect(text).toContain("Plugin-managed skills are not refreshed with `skillwiki install`");
    expect(text).toContain("Do not run `skillwiki install` just to refresh plugin-managed skills");
    expect(text).toContain("Only use `skillwiki install --force`");
  });

  it("root Antigravity plugin layout exposes Claude hooks under hooks/", () => {
    const rootHooksDir = join(REPO_ROOT, "hooks");

    expect(existsSync(join(rootHooksDir, "hooks.json"))).toBe(true);
    expect(existsSync(join(rootHooksDir, "run-hook.cmd"))).toBe(true);
    expect(existsSync(join(rootHooksDir, "session-context"))).toBe(true);
    expect(existsSync(join(rootHooksDir, "session-start"))).toBe(true);

    expectNotSymlink(rootHooksDir);
    expectNotSymlink(join(rootHooksDir, "hooks.json"));
    expectNotSymlink(join(rootHooksDir, "run-hook.cmd"));
    expectNotSymlink(join(rootHooksDir, "session-context"));
    expectNotSymlink(join(rootHooksDir, "session-start"));

    expect(readFileSync(join(rootHooksDir, "hooks.json"), "utf8")).toBe(
      readFileSync(join(SKILLS_DIR, "hooks", "hooks.json"), "utf8"),
    );
    expect(readFileSync(join(rootHooksDir, "run-hook.cmd"), "utf8")).toBe(
      readFileSync(join(SKILLS_DIR, "hooks", "run-hook.cmd"), "utf8"),
    );
    expect(readFileSync(join(rootHooksDir, "session-context"), "utf8")).toBe(
      readFileSync(join(SKILLS_DIR, "hooks", "session-context"), "utf8"),
    );
    expect(readFileSync(join(rootHooksDir, "session-start"), "utf8")).toBe(
      readFileSync(join(SKILLS_DIR, "hooks", "session-start"), "utf8"),
    );
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
