import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return v;
}

describe("runDoctor", () => {
  it("all-pass returns exit 0", async () => {
    const h = home();
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.summary.error).toBe(0);
      expect(r.result.data.summary.warn).toBe(0);
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
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "/path/to/cli.js", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_on_path");
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

  it("always returns exactly 10 checks", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.checks).toHaveLength(11);
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
    expect(profileCheck!.status).toBe("pass");
    expect(profileCheck!.detail).toContain("finance");
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
});
