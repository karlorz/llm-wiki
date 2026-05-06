import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/commands/install.js";

function fakeSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-src-"));
  mkdirSync(join(dir, "wiki-init"), { recursive: true });
  writeFileSync(join(dir, "wiki-init", "SKILL.md"), "# wiki-init");
  mkdirSync(join(dir, "proj-init"), { recursive: true });
  writeFileSync(join(dir, "proj-init", "SKILL.md"), "# proj-init");
  return dir;
}

describe("install", () => {
  it("performs --dry-run without writing files", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(false);
  });

  it("installs both skills and writes manifest", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "proj-init", "SKILL.md"))).toBe(true);
    if (r.result.ok) {
      const manifest = JSON.parse(readFileSync(r.result.data.manifest_path, "utf8"));
      expect(manifest.installed.length).toBe(2);
    }
  });

  it("is idempotent on a second run", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    await runInstall({ skillsRoot, target, dryRun: false });
    const r = await runInstall({ skillsRoot, target, dryRun: false });
    expect(r.exitCode).toBe(0);
  });

  it("installs bin/skillwiki wrapper when present", async () => {
    const skillsRoot = fakeSkillsDir();
    mkdirSync(join(skillsRoot, "bin"), { recursive: true });
    writeFileSync(join(skillsRoot, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx -y skillwiki@beta \"$@\"");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "bin", "skillwiki"))).toBe(true);
  });
});
