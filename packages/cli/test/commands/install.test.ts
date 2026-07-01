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

/** Build a fake HOME with no plugin registry so deferral is not triggered. */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "home-"));
}

/** Build a fake HOME whose plugin registry declares skillwiki@llm-wiki installed. */
function fakeHomeWithPlugin(version = "0.9.28"): string {
  const h = mkdtempSync(join(tmpdir(), "home-plugin-"));
  mkdirSync(join(h, ".claude", "plugins"), { recursive: true });
  const installPath = join(h, ".claude", "plugins", "cache", "llm-wiki", "skillwiki", version);
  mkdirSync(installPath, { recursive: true });
  writeFileSync(
    join(h, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "skillwiki@llm-wiki": [
          {
            scope: "user",
            installPath,
            version,
            installedAt: "2026-07-01T00:00:00.000Z",
            lastUpdated: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    }),
  );
  return h;
}

describe("install", () => {
  it("performs --dry-run without writing files", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: true, symlink: false, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(false);
  });

  it("installs both skills and writes manifest", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
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
    await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(0);
  });

  it("installs bin/skillwiki wrapper when present", async () => {
    const skillsRoot = fakeSkillsDir();
    mkdirSync(join(skillsRoot, "bin"), { recursive: true });
    writeFileSync(join(skillsRoot, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx -y skillwiki@latest \"$@\"");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(target, "bin", "skillwiki"))).toBe(true);
  });

  it("--symlink creates symlinks instead of copies", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: true, home: fakeHome(), force: false });
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

  it("returns PREFLIGHT_FAILED when no skill directories have SKILL.md", async () => {
    // skillsRoot with dirs but no SKILL.md in any of them
    const skillsRoot = mkdtempSync(join(tmpdir(), "skills-src-"));
    mkdirSync(join(skillsRoot, "wiki-init"), { recursive: true });
    // Deliberately do NOT write SKILL.md anywhere
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe("PREFLIGHT_FAILED");
    }
  });

  it("skips directories without SKILL.md and installs those with it", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "skills-src-"));
    mkdirSync(join(skillsRoot, "wiki-init"), { recursive: true });
    // Deliberately do NOT write SKILL.md inside wiki-init
    mkdirSync(join(skillsRoot, "proj-init"), { recursive: true });
    writeFileSync(join(skillsRoot, "proj-init", "SKILL.md"), "---\nversion: 0.2.1\nname: proj-init\ndescription: Proj init\n---\n\n# proj-init");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(0);
    // Only proj-install got installed; wiki-init was skipped (no SKILL.md)
    expect(existsSync(join(target, "proj-init", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(false);
  });

  it("installs bin/skillwiki as symlink in symlink mode", async () => {
    const skillsRoot = fakeSkillsDir();
    mkdirSync(join(skillsRoot, "bin"), { recursive: true });
    writeFileSync(join(skillsRoot, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx -y skillwiki@latest \"$@\"");
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: true, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(0);
    const binPath = join(target, "bin", "skillwiki");
    expect(existsSync(binPath)).toBe(true);
    expect(lstatSync(binPath).isSymbolicLink()).toBe(true);
  });

  it("--symlink replaces existing copy with symlink", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    // First install as copy
    await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    expect(lstatSync(join(target, "wiki-init", "SKILL.md")).isFile()).toBe(true);
    // Re-install with symlink — replaces the copy
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: true, home: fakeHome(), force: false });
    expect(r.exitCode).toBe(0);
    expect(lstatSync(join(target, "wiki-init", "SKILL.md")).isSymbolicLink()).toBe(true);
  });

  it("records skill metadata in manifest", async () => {
    const skillsRoot = fakeSkillsDir();
    const target = mkdtempSync(join(tmpdir(), "tgt-"));
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
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
    await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    // Bump version in source
    writeFileSync(join(skillsRoot, "wiki-init", "SKILL.md"), "---\nversion: 0.3.0\nname: wiki-init\ndescription: Init skill\n---\n\n# wiki-init");
    // Reinstall should detect version change
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
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
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: fakeHome(), force: false });
    if (r.result.ok) {
      expect(r.result.data.version_warnings.some(w => w.includes("DEPRECATED"))).toBe(true);
      expect(r.result.data.manifest_path).toBeDefined();
    }
  });

  // --- Plugin-channel deferral ---

  it("defers to plugin channel when plugin is installed and target is default ~/.claude/skills", async () => {
    const skillsRoot = fakeSkillsDir();
    const h = fakeHomeWithPlugin("0.9.28");
    const target = join(h, ".claude", "skills"); // default target
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: h, force: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.deferred_to_plugin).toBe(true);
      expect(r.result.data.installed).toHaveLength(0);
      expect(r.result.data.humanHint).toContain("deferred to plugin");
      // No SKILL.md copies written, no manifest created
      expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(false);
      expect(existsSync(join(target, "wiki-manifest.json"))).toBe(false);
    }
  });

  it("defers even when default target has a trailing slash (CLI default form)", async () => {
    const skillsRoot = fakeSkillsDir();
    const h = fakeHomeWithPlugin("0.9.28");
    const target = `${join(h, ".claude", "skills")}/`; // matches cli.ts default `${HOME}/.claude/skills/`
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: h, force: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.deferred_to_plugin).toBe(true);
    }
  });

  it("installs into custom --target even when plugin is installed", async () => {
    const skillsRoot = fakeSkillsDir();
    const h = fakeHomeWithPlugin("0.9.28");
    const target = mkdtempSync(join(tmpdir(), "tgt-")); // non-default target
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: h, force: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.deferred_to_plugin).toBe(false);
      expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "wiki-manifest.json"))).toBe(true);
    }
  });

  it("--force installs into default target even when plugin is installed", async () => {
    const skillsRoot = fakeSkillsDir();
    const h = fakeHomeWithPlugin("0.9.28");
    const target = join(h, ".claude", "skills"); // default target
    const r = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home: h, force: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.deferred_to_plugin).toBe(false);
      expect(existsSync(join(target, "wiki-init", "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "wiki-manifest.json"))).toBe(true);
    }
  });

  it("defers in --dry-run too when plugin is installed and target is default", async () => {
    const skillsRoot = fakeSkillsDir();
    const h = fakeHomeWithPlugin("0.9.28");
    const target = join(h, ".claude", "skills");
    const r = await runInstall({ skillsRoot, target, dryRun: true, symlink: false, home: h, force: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.deferred_to_plugin).toBe(true);
    }
  });
});
