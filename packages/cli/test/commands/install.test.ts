import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/commands/install.js";

function fakeSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-src-"));
  mkdirSync(join(dir, "wiki-init"), { recursive: true });
  writeFileSync(join(dir, "wiki-init", "SKILL.md"), "---\nversion: 0.2.1\nname: wiki-init\ndescription: Init skill\n---\n\n# wiki-init");
  mkdirSync(join(dir, "proj-init"), { recursive: true });
  writeFileSync(join(dir, "proj-init", "SKILL.md"), "---\nversion: 0.2.1\nname: proj-init\ndescription: Proj init\n---\n\n# proj-init");
  return dir;
}

describe("install", () => {
  it("performs --dry-run without writing files", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: true, symlink: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(false);
  });

  it("installs both skills and writes manifest", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
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
    await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    expect(r.exitCode).toBe(0);
  });

  it("installs bin/skillwiki wrapper when present", async () => {
    const skillsRoot = fakeSkillsDir();
    mkdirSync(join(skillsRoot, "bin"), { recursive: true });
    writeFileSync(join(skillsRoot, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx -y skillwiki@beta \"$@\"");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "bin", "skillwiki"))).toBe(true);
  });

  it("--symlink creates symlinks instead of copies", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: true });
    expect(r.exitCode).toBe(0);
    // Verify symlinks were created
    const linkPath = join(target, "wiki-init", "SKILL.md");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(skillsRoot, "wiki-init", "SKILL.md"));
    // Manifest should record symlink mode
    if (r.result.ok) {
      const manifest = JSON.parse(readFileSync(r.result.data.manifest_path, "utf8"));
      expect(manifest.symlink).toBe(true);
    }
  });

  it("returns PREFLIGHT_FAILED when no skill directories match", async () => {
    // skillsRoot with only non-matching dirs (no wiki-*/proj-*)
    const skillsRoot = mkdtempSync(join(tmpdir(), "skills-src-"));
    mkdirSync(join(skillsRoot, "other-dir"), { recursive: true });
    writeFileSync(join(skillsRoot, "other-dir", "SKILL.md"), "# other");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe("PREFLIGHT_FAILED");
    }
  });

  it("returns PREFLIGHT_FAILED when a skill directory has no SKILL.md", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "skills-src-"));
    mkdirSync(join(skillsRoot, "wiki-init"), { recursive: true });
    // Deliberately do NOT write SKILL.md inside wiki-init
    mkdirSync(join(skillsRoot, "proj-init"), { recursive: true });
    writeFileSync(join(skillsRoot, "proj-init", "SKILL.md"), "# proj-init");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe("PREFLIGHT_FAILED");
    }
  });

  it("installs bin/skillwiki as symlink in symlink mode", async () => {
    const skillsRoot = fakeSkillsDir();
    mkdirSync(join(skillsRoot, "bin"), { recursive: true });
    writeFileSync(join(skillsRoot, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx -y skillwiki@beta \"$@\"");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: true });
    expect(r.exitCode).toBe(0);
    const binPath = join(target, "bin", "skillwiki");
    expect(existsSync(binPath)).toBe(true);
    expect(lstatSync(binPath).isSymbolicLink()).toBe(true);
  });

  it("--symlink replaces existing copy with symlink", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    // First install as copy
    await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    expect(lstatSync(join(target, "wiki-init", "SKILL.md")).isFile()).toBe(true);
    // Re-install with symlink — replaces the copy
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: true });
    expect(r.exitCode).toBe(0);
    expect(lstatSync(join(target, "wiki-init", "SKILL.md")).isSymbolicLink()).toBe(true);
  });

  it("records skill metadata in manifest", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      const manifest = JSON.parse(readFileSync(r.result.data.manifest_path, "utf8"));
      expect(manifest.skills).toBeDefined();
      expect(manifest.skills["wiki-init"].name).toBe("wiki-init");
      expect(manifest.skills["wiki-init"].version).toBe("0.2.1");
    }
  });

  it("detects version mismatch on reinstall", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    // Initial install
    await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    // Bump version in source
    writeFileSync(join(skillsRoot, "wiki-init", "SKILL.md"), "---\nversion: 0.3.0\nname: wiki-init\ndescription: Init skill\n---\n\n# wiki-init");
    // Reinstall should detect version change
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    if (r.result.ok) {
      expect(r.result.data.version_warnings.length).toBeGreaterThan(0);
      expect(r.result.data.version_warnings.some(w => w.includes("0.2.1") && w.includes("0.3.0"))).toBe(true);
    }
  });

  it("detects deprecated skill", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "skills-src-"));
    mkdirSync(join(skillsRoot, "wiki-old"), { recursive: true });
    writeFileSync(join(skillsRoot, "wiki-old", "SKILL.md"), "---\nversion: 0.1.0\nname: wiki-old\ndeprecated: true\ndescription: Old skill\n---\n\n# wiki-old");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    if (r.result.ok) {
      expect(r.result.data.version_warnings.some(w => w.includes("DEPRECATED"))).toBe(true);
      expect(r.result.data.manifest_path).toBeDefined();
    }
  });
});
