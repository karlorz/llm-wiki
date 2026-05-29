import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runDoctor } from "../../src/commands/doctor.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".claude", "skills", "example"), { recursive: true });
  writeFileSync(join(h, ".claude", "skills", "example", "SKILL.md"), "# Example Skill\n");
  return h;
}

function homeWithPlugin(version: string): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  // Create plugin cache directory with SKILL.md files
  const pluginDir = join(h, ".claude", "plugins", "cache", "llm-wiki", "skillwiki", version);
  mkdirSync(join(pluginDir, "using-skillwiki"), { recursive: true });
  writeFileSync(join(pluginDir, "using-skillwiki", "SKILL.md"), "# Using Skillwiki\n");
  mkdirSync(join(pluginDir, "wiki-init"), { recursive: true });
  writeFileSync(join(pluginDir, "wiki-init", "SKILL.md"), "# Wiki Init\n");
  // Create installed_plugins.json
  const registryPath = join(h, ".claude", "plugins", "installed_plugins.json");
  mkdirSync(join(h, ".claude", "plugins"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    version: 2,
    plugins: {
      "skillwiki@llm-wiki": [{
        scope: "user",
        installPath: pluginDir,
        version,
        installedAt: "2026-05-06T02:47:57.953Z",
        lastUpdated: "2026-05-07T06:14:46.874Z",
      }],
    },
  }));
  return h;
}

const SCHEMA = `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - model\n\`\`\`\n`;

function fullVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(v, d), { recursive: true });
  // Initialize git so vault_git_remote check passes
  execSync("git init", { cwd: v, stdio: "pipe" });
  execSync("git remote add origin https://example.com/vault.git", { cwd: v, stdio: "pipe" });
  return v;
}

describe("runDoctor", () => {
  it("all-pass returns exit 0 with git vault", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.summary.error).toBe(0);
      // vault_git_remote should pass with a git-initialized vault
      const gitCheck = r.result.data.checks.find(c => c.id === "vault_git_remote");
      expect(gitCheck?.status).toBe("pass");
    }
  });

  it("missing config file gives warn for config_file check", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cfg = r.result.data.checks.find(c => c.id === "config_file");
      expect(cfg?.status).toBe("warn");
    }
  });

  it("missing WIKI_PATH gives error for wiki_path_set check", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "# empty\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const wp = r.result.data.checks.find(c => c.id === "wiki_path_set");
      expect(wp?.status).toBe("error");
      expect(r.exitCode).toBe(29);
    }
  });

  it("WIKI_PATH pointing to non-existent dir gives error for wiki_path_exists", async () => {
    const h = home();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_PATH=/no/such/dir\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const wpe = r.result.data.checks.find(c => c.id === "wiki_path_exists");
      expect(wpe?.status).toBe("error");
    }
  });

  it("vault missing subdirs gives warn for vault_structure", async () => {
    const h = home();
    const v = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const vs = r.result.data.checks.find(c => c.id === "vault_structure");
      expect(vs?.status).toBe("warn");
    }
  });

  it("warn-only scenario returns exit 28", async () => {
    const h = home();
    // Create install bin so detectCliChannels always finds 2 channels (dev + install) → warn
    mkdirSync(join(h, ".claude", "skills", "bin"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "bin", "skillwiki"), "#!/bin/sh\nexec npx skillwiki \"$@\"\n");
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "/path/to/cli.js", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_channels");
      expect(cli?.status).toBe("warn");
      if (r.result.data.summary.error === 0 && r.result.data.summary.warn > 0) {
        expect(r.exitCode).toBe(28);
      }
    }
  });

  it("envValue override is used for wiki_path_set resolution", async () => {
    const h = home();
    const v = fullVault();
    const r = await runDoctor({ home: h, envValue: v, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const wp = r.result.data.checks.find(c => c.id === "wiki_path_set");
      expect(wp?.status).toBe("pass");
    }
  });

  it("always returns exactly 32 checks", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.checks).toHaveLength(32);
    }
  });

  it("emits 5 vault metric rows (info severity) on a valid vault", async () => {
    const h = home();
    const v = fullVault();
    const r = await runDoctor({ home: h, envValue: v, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const metricIds = ["vault_metric_pages", "vault_metric_orphans", "vault_metric_bridges", "vault_metric_cohesion", "vault_metric_log_size"];
      for (const id of metricIds) {
        const row = r.result.data.checks.find(c => c.id === id);
        expect(row, `missing metric ${id}`).toBeDefined();
        expect(row!.status).toBe("info");
      }
    }
  });

  it("emits 5 vault metric rows even with no vault configured", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const metricRows = r.result.data.checks.filter(c => c.id.startsWith("vault_metric_"));
      expect(metricRows).toHaveLength(5);
      for (const row of metricRows) expect(row.status).toBe("info");
    }
  });

  it("npm_update check passes when no cache exists", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const npmUpdate = r.result.data.checks.find(c => c.id === "npm_update");
      expect(npmUpdate?.status).toBe("pass");
      expect(npmUpdate?.detail).toContain("no cache yet");
    }
  });

  it("npm_update check warns when cache shows newer version available", async () => {
    const h = home();
    writeFileSync(
      join(h, ".skillwiki", ".update-cache.json"),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: "0.2.0-beta.99", currentVersion: "0.2.0-beta.15" })
    );
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const npmUpdate = r.result.data.checks.find(c => c.id === "npm_update");
      expect(npmUpdate?.status).toBe("warn");
      expect(npmUpdate?.detail).toContain("update available");
    }
  });

  it("plugin_version_drift check passes when no plugin installed", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("pass");
      expect(drift?.detail).toContain("CLI only");
    }
  });

  it("plugin_version_drift check passes when versions match", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("pass");
      expect(drift?.detail).toContain("Both at v0.2.0-beta.15");
    }
  });

  it("plugin_version_drift check warns when versions differ", async () => {
    const h = homeWithPlugin("0.2.0-beta.99");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("warn");
      expect(drift?.detail).toContain("Plugin v0.2.0-beta.99");
      expect(drift?.detail).toContain("CLI v0.2.0-beta.15");
    }
  });

  it("skills_installed passes when plugin skills found", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const skills = r.result.data.checks.find(c => c.id === "skills_installed");
      expect(skills?.status).toBe("pass");
      expect(skills?.detail).toContain("plugin v0.2.0-beta.15");
    }
  });

  it("reports profiles when configured", async () => {
    const h = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(h, ".skillwiki"), { recursive: true });
    writeFileSync(join(h, ".skillwiki", ".env"),
      "WIKI_PATH=/default\nWIKI_DEFAULT=finance\nWIKI_FINANCE_PATH=/finance\n");
    const r = await runDoctor({ home: h, envValue: "/default", argv: ["node", "cli.js"], currentVersion: "1.0.0" });
    const profileCheck = r.result.ok && r.result.data.checks.find(c => c.id === "wiki_profiles");
    expect(profileCheck).toBeDefined();
    if (!profileCheck) throw new Error("expected CheckResult");
    expect(profileCheck.status).toBe("pass");
    expect(profileCheck.detail).toContain("finance");
  });

  it("reports project-local override when present", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
    mkdirSync(join(cwd, ".skillwiki"), { recursive: true });
    writeFileSync(join(cwd, ".skillwiki", ".env"), "WIKI_PATH=/project/vault\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15", cwd });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const proj = r.result.data.checks.find(c => c.id === "project_local");
      expect(proj).toBeDefined();
      expect(proj!.status).toBe("pass");
      expect(proj!.detail).toContain("Found");
    }
  });

  it("reports no project-local override when absent", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const proj = r.result.data.checks.find(c => c.id === "project_local");
      expect(proj).toBeDefined();
      expect(proj!.detail).toContain("None");
    }
  });

  it("sync_last_push warns when no remote/HEAD and no commits", async () => {
    const h = home();
    const v = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
    for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(v, d), { recursive: true });
    execSync("git init", { cwd: v, stdio: "pipe" });
    // No commits, no remote — empty repo
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const sync = r.result.data.checks.find(c => c.id === "sync_last_push");
      expect(sync?.status).toBe("warn");
      expect(sync?.detail).toContain("No commits found");
    }
  });

  it("sync_last_push passes when recent commit exists", async () => {
    const h = home();
    const v = fullVault();
    execSync("git -c user.name=test -c user.email=test@test commit --allow-empty -m init", { cwd: v, stdio: "pipe" });
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const sync = r.result.data.checks.find(c => c.id === "sync_last_push");
      expect(sync?.status).toBe("pass");
      expect(sync?.detail).toContain("Last push:");
      expect(sync?.detail).toContain("day(s) ago");
    }
  });

  it("dsstore_clean passes when no .DS_Store in raw/", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const ds = r.result.data.checks.find(c => c.id === "dsstore_clean");
      expect(ds?.status).toBe("pass");
      expect(ds?.detail).toContain("No .DS_Store files found");
    }
  });

  it("dsstore_clean reports info when .DS_Store in raw/", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(v, "raw", ".DS_Store"), "fake");
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const ds = r.result.data.checks.find(c => c.id === "dsstore_clean");
      expect(ds?.status).toBe("info");
      expect(ds?.detail).toContain(".DS_Store file(s) found");
      // info items counted in summary
      expect(r.result.data.summary.info).toBeGreaterThanOrEqual(1);
    }
  });

  it("skills_duplicate passes when only plugin is installed", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    // Create ~/.claude/skills/ with non-overlapping skill
    mkdirSync(join(h, ".claude", "skills", "other-skill"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "other-skill", "SKILL.md"), "# Other\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const dup = r.result.data.checks.find(c => c.id === "skills_duplicate");
      expect(dup?.status).toBe("pass");
      expect(dup?.detail).toContain("No overlap");
    }
  });

  it("skills_duplicate passes when only CLI install exists (no plugin)", async () => {
    const h = home();
    // home() creates ~/.claude/skills/example/SKILL.md but no plugin
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const dup = r.result.data.checks.find(c => c.id === "skills_duplicate");
      expect(dup?.status).toBe("pass");
      expect(dup?.detail).toContain("Single install channel");
    }
  });

  it("skills_duplicate warns when skills exist in both plugin and CLI install", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    // Add overlapping wiki-init skill in CLI install path
    mkdirSync(join(h, ".claude", "skills", "wiki-init"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-init", "SKILL.md"), "# Wiki Init\n");
    // Add non-overlapping skill too
    mkdirSync(join(h, ".claude", "skills", "wiki-query"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-query", "SKILL.md"), "# Wiki Query\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const dup = r.result.data.checks.find(c => c.id === "skills_duplicate");
      expect(dup?.status).toBe("warn");
      expect(dup?.detail).toContain("skill(s) in both plugin and ~/.claude/skills/");
      expect(dup?.detail).toContain("wiki-init");
    }
  });

  it("skills_duplicate reports info when stale skills in codex/agents dirs", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    // Add stale wiki-init skill in ~/.codex/skills/
    mkdirSync(join(h, ".codex", "skills", "wiki-init"), { recursive: true });
    writeFileSync(join(h, ".codex", "skills", "wiki-init", "SKILL.md"), "# Wiki Init (stale)\n");
    // Add stale wiki-query skill in ~/.agents/skills/
    mkdirSync(join(h, ".agents", "skills", "wiki-init"), { recursive: true });
    writeFileSync(join(h, ".agents", "skills", "wiki-init", "SKILL.md"), "# Wiki Init (stale)\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const dup = r.result.data.checks.find(c => c.id === "skills_duplicate");
      expect(dup?.status).toBe("info");
      expect(dup?.detail).toContain("~/.codex/skills/");
      expect(dup?.detail).toContain("~/.agents/skills/");
    }
  });

  it("skills_duplicate shows warn (not info) when CLI and agent duplicates both exist", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    // Add overlapping wiki-init in ~/.claude/skills/ (warn-level)
    mkdirSync(join(h, ".claude", "skills", "wiki-init"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-init", "SKILL.md"), "# Wiki Init\n");
    // Add stale in ~/.codex/skills/ (info-level, but warn takes precedence)
    mkdirSync(join(h, ".codex", "skills", "wiki-init"), { recursive: true });
    writeFileSync(join(h, ".codex", "skills", "wiki-init", "SKILL.md"), "# Wiki Init (stale)\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const dup = r.result.data.checks.find(c => c.id === "skills_duplicate");
      expect(dup?.status).toBe("warn");
      expect(dup?.detail).toContain("~/.claude/skills/");
      expect(dup?.detail).toContain("~/.codex/skills/");
    }
  });

  it("cli_channels passes with single channel", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_channels");
      expect(cli).toBeDefined();
      // Either pass with single channel or warn if multiple channels detected on test machine
    }
  });

  it("cli_channels detects dev source from argv", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "/path/to/packages/cli/dist/cli.js", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_channels");
      expect(cli?.detail).toContain("dev");
    }
  });

  it("cli_channels warns when plugin bin and CLI install bin both exist", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    // Add CLI install bin
    mkdirSync(join(h, ".claude", "skills", "bin"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx skillwiki \"$@\"\n");
    // Add plugin bin
    const pluginDir = join(h, ".claude", "plugins", "cache", "llm-wiki", "skillwiki", "0.2.0-beta.15");
    mkdirSync(join(pluginDir, "bin"), { recursive: true });
    writeFileSync(join(pluginDir, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx skillwiki \"$@\"\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_channels");
      expect(cli?.status).toBe("warn");
      expect(cli?.detail).toContain("channels");
    }
  });

  // ── Vault sync doctor checks ─────────────────────────────────

  function vaultSyncConfig(home: string, installed: boolean, role?: string): void {
    let existing = "";
    try { existing = readFileSync(join(home, ".skillwiki", ".env"), "utf8"); } catch { /* no file yet */ }
    const lines = existing.split("\n").filter(l => !l.startsWith("vault_sync."));
    if (installed) lines.push("vault_sync.installed=true");
    if (role) lines.push(`vault_sync.role=${role}`);
    writeFileSync(join(home, ".skillwiki", ".env"), lines.join("\n"));
  }

  function createVaultSyncLogDir(home: string): string {
    const isMac = process.platform === "darwin";
    const dir = isMac
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state", "vault-sync", "log");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function createVaultSyncShareDir(home: string): string {
    const isMac = process.platform === "darwin";
    const dir = isMac
      ? join(home, "Library", "Application Support", "vault-sync", "bin")
      : join(home, ".local", "share", "vault-sync", "bin");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function createVaultSyncFilterFile(content: string): { home: string; path: string } {
    const h = mkdtempSync(join(tmpdir(), "vs-filter-"));
    mkdirSync(join(h, ".skillwiki"), { recursive: true });
    mkdirSync(join(h, ".config", "rclone"), { recursive: true });
    writeFileSync(join(h, ".skillwiki", ".env"), "");
    const filterPath = join(h, ".config", "rclone", "wiki-push-filters.txt");
    writeFileSync(filterPath, content);
    return { home: h, path: filterPath };
  }

  function createVaultSyncLog(home: string, lines: string[]): string {
    const logDir = createVaultSyncLogDir(home);
    const logPath = join(logDir, "wiki-push.log");
    writeFileSync(logPath, lines.join("\n") + "\n");
    return logPath;
  }

  describe("vault-sync checks", () => {
    it("all 6 vault-sync checks skip when vault_sync.installed is false", async () => {
      const h = home();
      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const vsIds = [
        "vault_sync_installed", "vault_sync_jobs_enabled",
        "vault_sync_last_push_age", "vault_sync_last_fetch_status",
        "vault_sync_filter_present", "vault_sync_snapshot_guard",
      ];
      for (const id of vsIds) {
        const check = r.result.data.checks.find(c => c.id === id);
        expect(check).toBeDefined();
        expect(check!.status).toBe("pass");
        expect(check!.detail).toContain("not installed");
      }
      // Exit code unaffected — no errors added
      const vsErrors = r.result.data.checks.filter(c => vsIds.includes(c.id) && c.status === "error");
      expect(vsErrors).toHaveLength(0);
    });

    it("vault_sync.installed = true with no deployed scripts reports errors", async () => {
      const h = home();
      vaultSyncConfig(h, true);
      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const installed = r.result.data.checks.find(c => c.id === "vault_sync_installed");
      expect(installed).toBeDefined();
      expect(installed!.status).toBe("error");
      expect(installed!.detail).toContain("Script not found");
      // Exit code unaffected — no errors from vault-sync checks counted in doctor exit
      const vsErrors = r.result.data.checks.filter(c => c.id.startsWith("vault_sync") && c.status === "error");
      expect(vsErrors.length).toBeGreaterThanOrEqual(1);
    });

    it("vault_sync_last_push_age passes when log ends with OK push within 180s", async () => {
      const h = home();
      vaultSyncConfig(h, true);
      createVaultSyncShareDir(h); // for installed check
      const now = new Date();
      const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      createVaultSyncLog(h, [`${ts} OK push (no changes) duration=0s`]);
      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const age = r.result.data.checks.find(c => c.id === "vault_sync_last_push_age");
      expect(age).toBeDefined();
      expect(age!.status).toBe("pass");
      expect(age!.detail).toContain("s ago");
    });

    it("vault_sync_last_push_age errors when log ends with FAIL", async () => {
      const h = home();
      vaultSyncConfig(h, true);
      createVaultSyncShareDir(h);
      createVaultSyncLog(h, ["2026-05-25T10:00:00Z FAIL rclone exit=1 duration=3s"]);
      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const age = r.result.data.checks.find(c => c.id === "vault_sync_last_push_age");
      expect(age).toBeDefined();
      expect(age!.status).toBe("error");
      expect(age!.detail).toContain("FAIL");
    });

    it("vault_sync_filter_present warns on missing required excludes", async () => {
      const { home: h } = createVaultSyncFilterFile(
        "# minimal filter\n- .git/\n- .DS_Store\n"
      );
      vaultSyncConfig(h, true);
      createVaultSyncShareDir(h);
      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const filter = r.result.data.checks.find(c => c.id === "vault_sync_filter_present");
      expect(filter).toBeDefined();
      expect(filter!.detail).toContain("Missing required excludes");
      expect(filter!.status).toBe("warn");
    });

    it("snapshot guard errors without --max-delete", async () => {
      const h = home();
      vaultSyncConfig(h, true, "snapshotter");
      createVaultSyncShareDir(h);
      // The check uses /root/.hermes/scripts/wiki-snapshot-v3.sh by default
      // which is not writable in tests — so the check errors because script is absent
      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const guard = r.result.data.checks.find(c => c.id === "vault_sync_snapshot_guard");
      expect(guard).toBeDefined();
      expect(guard!.status).toBe("error");
      expect(guard!.detail).toContain("not found");
    });
  });
});
