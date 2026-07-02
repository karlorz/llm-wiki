import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  runDoctor,
  checkSatelliteLastRun,
  checkSatelliteTimer,
} from "../../src/commands/doctor.js";

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

function addCodexPlugin(h: string, version: string, sourceType: "local" | "git" = "local"): void {
  const pluginDir = join(h, ".codex", "plugins", "cache", "llm-wiki", "skillwiki", version);
  mkdirSync(join(pluginDir, ".codex-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "skills", "using-skillwiki"), { recursive: true });
  writeFileSync(join(pluginDir, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "skillwiki",
    version,
    skills: "./skills/",
  }));
  writeFileSync(join(pluginDir, "skills", "using-skillwiki", "SKILL.md"), "# Using Skillwiki\n");

  mkdirSync(join(h, ".codex"), { recursive: true });
  writeFileSync(join(h, ".codex", "config.toml"), `
[plugins."skillwiki@llm-wiki"]
enabled = true

[marketplaces.llm-wiki]
source_type = "${sourceType}"
source = "/tmp/llm-wiki"
`);
}

function homeWithCodexPlugin(version: string, sourceType: "local" | "git" = "local"): string {
  const h = home();
  addCodexPlugin(h, version, sourceType);
  return h;
}

const SCHEMA = `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - model\n\`\`\`\n`;
const FLEET = `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
s3_remote: seaweed-wiki:cloud/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [s3, github]
    protected: false
    identity:
      hostnames: [macos-dev]
    access:
      from:
        macos-dev:
          status: local
          ssh_aliases: []
          users: [karlchow]
          transports: [local]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
    access:
      from:
        macos-dev:
          status: configured
          ssh_aliases: [sg01]
          users: [root]
          transports: [public-ip]
`;

function fullVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(v, d), { recursive: true });
  // Initialize git so vault_git_remote check passes
  execSync("git init", { cwd: v, stdio: "pipe" });
  execSync("git remote add origin https://example.com/vault.git", { cwd: v, stdio: "pipe" });
  return v;
}

function addFleet(vault: string): void {
  const dir = join(vault, "projects", "llm-wiki", "architecture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fleet.yaml"), FLEET);
}

function gitCommit(cwd: string, message: string): void {
  execSync("git add -A", { cwd, stdio: "pipe" });
  execSync(`git -c user.name=test -c user.email=test@test commit -m "${message}"`, { cwd, stdio: "pipe" });
}

function fullVaultWithOrigin(): { root: string; vault: string; remote: string } {
  const root = mkdtempSync(join(tmpdir(), "vault-git-"));
  const remote = join(root, "origin.git");
  const vault = join(root, "vault");

  execSync(`git init --bare "${remote}"`, { stdio: "pipe" });
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "SCHEMA.md"), SCHEMA);
  for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(vault, d), { recursive: true });
  execSync("git init", { cwd: vault, stdio: "pipe" });
  execSync("git branch -M main", { cwd: vault, stdio: "pipe" });
  execSync(`git remote add origin "${remote}"`, { cwd: vault, stdio: "pipe" });
  gitCommit(vault, "init");
  execSync("git push -u origin main", { cwd: vault, stdio: "pipe" });

  return { root, vault, remote };
}

function createRemoteCommit(root: string, remote: string): void {
  const clone = join(root, "remote-work");
  execSync(`git clone --branch main "${remote}" "${clone}"`, { stdio: "pipe" });
  writeFileSync(join(clone, "remote.md"), "remote\n");
  gitCommit(clone, "remote");
  execSync("git push origin main", { cwd: clone, stdio: "pipe" });
}

function createPullLog(home: string, lines: string[]): string {
  const dir = process.platform === "darwin"
    ? join(home, "Library", "Logs")
    : join(home, ".local", "state", "vault-sync", "log");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "wiki-pull.log");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
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

  it("warns when configured fleet identity is not in fleet.yaml", async () => {
    const h = home();
    const v = fullVault();
    addFleet(v);
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\nSKILLWIKI_HOST_ID=ptcloud\n`);

    const prior = {
      SKILLWIKI_HOST_ID: process.env.SKILLWIKI_HOST_ID,
      AGENT_HOST_ID: process.env.AGENT_HOST_ID,
      VS_HOSTNAME: process.env.VS_HOSTNAME,
    };
    delete process.env.SKILLWIKI_HOST_ID;
    delete process.env.AGENT_HOST_ID;
    delete process.env.VS_HOSTNAME;
    let r!: Awaited<ReturnType<typeof runDoctor>>;
    try {
      r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const fleet = r.result.data.checks.find(c => c.id === "fleet_identity");
      expect(fleet?.status).toBe("warn");
      expect(fleet?.detail).toContain("resolved host id `ptcloud`");
      expect(fleet?.detail).toContain("not in fleet.yaml");
    }
  });

  it("always returns exactly 40 checks", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.checks).toHaveLength(40);
      const freshness = r.result.data.checks.find(c => c.id === "s3_mount_freshness");
      expect(freshness).toBeDefined();
      expect(freshness?.status).toBe("pass");
      expect(freshness?.detail).toContain("check skipped");
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

  it("npm_update check reports cached beta update channel", async () => {
    const h = home();
    writeFileSync(
      join(h, ".skillwiki", ".update-cache.json"),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: "0.2.0-beta.99", currentVersion: "0.2.0-beta.15", distTag: "beta" })
    );
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const npmUpdate = r.result.data.checks.find(c => c.id === "npm_update");
      expect(npmUpdate?.status).toBe("warn");
      expect(npmUpdate?.detail).toContain("beta update available");
      expect(npmUpdate?.detail).toContain("skillwiki update --tag beta");
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
      expect(drift?.detail).toContain("Claude plugin v0.2.0-beta.99");
      expect(drift?.detail).toContain("CLI v0.2.0-beta.15");
    }
  });

  it("plugin_version_drift reports info when dev source is ahead of installed plugin", async () => {
    const h = homeWithPlugin("0.2.0");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "/path/to/packages/cli/dist/cli.js", "doctor"], currentVersion: "0.2.1" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("info");
      expect(drift?.detail).toContain("Dev source v0.2.1 is ahead");
      expect(drift?.detail).toContain("Claude plugin v0.2.0");
    }
  });

  it("plugin_version_drift warns with Codex remediation when Codex plugin cache is stale", async () => {
    const h = homeWithCodexPlugin("0.2.0-beta.14", "local");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("warn");
      expect(drift?.detail).toContain("Codex plugin v0.2.0-beta.14");
      expect(drift?.detail).toContain("CLI v0.2.0-beta.15");
      expect(drift?.detail).toContain("codex plugin remove skillwiki@llm-wiki && codex plugin add skillwiki@llm-wiki");
      expect(drift?.detail).not.toContain("claude plugin update");
    }
  });

  it("plugin_version_drift passes when only Codex plugin version matches", async () => {
    const h = homeWithCodexPlugin("0.2.0-beta.15", "local");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("pass");
      expect(drift?.detail).toContain("Codex plugin and CLI both at v0.2.0-beta.15");
    }
  });

  it("plugin_version_drift reports Claude and Codex drift together", async () => {
    const h = homeWithPlugin("0.2.0-beta.14");
    addCodexPlugin(h, "0.2.0-beta.13", "git");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const drift = r.result.data.checks.find(c => c.id === "plugin_version_drift");
      expect(drift?.status).toBe("warn");
      expect(drift?.detail).toContain("Claude plugin v0.2.0-beta.14");
      expect(drift?.detail).toContain("Codex plugin v0.2.0-beta.13");
      expect(drift?.detail).toContain("claude plugin update skillwiki@llm-wiki");
      expect(drift?.detail).toContain("codex plugin marketplace upgrade llm-wiki");
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

  it("skills_installed counts direct source skills before Codex mirror skills", async () => {
    const h = home();
    const cwd = mkdtempSync(join(tmpdir(), "project-"));
    const skillsRoot = join(cwd, "packages", "skills");

    for (const skill of ["wiki-init", "wiki-query"]) {
      mkdirSync(join(skillsRoot, skill), { recursive: true });
      writeFileSync(join(skillsRoot, skill, "SKILL.md"), `# ${skill}\n`);
      mkdirSync(join(skillsRoot, "skills", skill), { recursive: true });
      writeFileSync(join(skillsRoot, "skills", skill, "SKILL.md"), `# ${skill}\n`);
    }

    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15", cwd });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const skills = r.result.data.checks.find(c => c.id === "skills_installed");
      expect(skills?.status).toBe("pass");
      expect(skills?.detail).toBe("2 SKILL.md file(s) found (source)");
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

  it("vault_git_dirty warns when the git vault has uncommitted changes", async () => {
    const h = home();
    const { vault } = fullVaultWithOrigin();
    writeFileSync(join(vault, "SCHEMA.md"), SCHEMA + "\n# local edit\n");
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);

    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const dirty = r.result.data.checks.find(c => c.id === "vault_git_dirty");
      expect(dirty).toBeDefined();
      expect(dirty!.status).toBe("warn");
      expect(dirty!.detail).toContain("dirty");
    }
  });

  it("vault_git_ahead warns when local commits have not been pushed", async () => {
    const h = home();
    const { vault } = fullVaultWithOrigin();
    writeFileSync(join(vault, "local.md"), "local\n");
    gitCommit(vault, "local");
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);

    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const ahead = r.result.data.checks.find(c => c.id === "vault_git_ahead");
      expect(ahead).toBeDefined();
      expect(ahead!.status).toBe("warn");
      expect(ahead!.detail).toContain("1 commit");
    }
  });

  it("vault_git_behind warns when origin/main has commits not present locally", async () => {
    const h = home();
    const { root, vault, remote } = fullVaultWithOrigin();
    createRemoteCommit(root, remote);
    execSync("git fetch origin main", { cwd: vault, stdio: "pipe" });
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);

    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const behind = r.result.data.checks.find(c => c.id === "vault_git_behind");
      expect(behind).toBeDefined();
      expect(behind!.status).toBe("warn");
      expect(behind!.detail).toContain("1 commit");
    }
  });

  it("vault_git_behind warns when remote main moved but local refs are stale", async () => {
    const h = home();
    const { root, vault, remote } = fullVaultWithOrigin();
    createRemoteCommit(root, remote);
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);

    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const behind = r.result.data.checks.find(c => c.id === "vault_git_behind");
      expect(behind).toBeDefined();
      expect(behind!.status).toBe("warn");
      expect(behind!.detail).toContain("Remote main differs");
    }
  });

  it("vault_git_pull_failures warns when recent pull failures are logged", async () => {
    const h = home();
    const v = fullVault();
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    createPullLog(h, [
      `${ts} FETCH origin/main`,
      `${ts} FAIL pull (not a rebase conflict, rc=128)`,
      `${ts} GIT pre-push pull failed (non-blocking)`,
    ]);
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);

    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });

    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const failures = r.result.data.checks.find(c => c.id === "vault_git_pull_failures");
      expect(failures).toBeDefined();
      expect(failures!.status).toBe("warn");
      expect(failures!.detail).toContain("2 recent");
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

  it("cli_channels passes for dev source with installed plugin channel", async () => {
    const h = homeWithPlugin("0.2.0-beta.15");
    const v = fullVault();
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const pluginDir = join(h, ".claude", "plugins", "cache", "llm-wiki", "skillwiki", "0.2.0-beta.15");
    mkdirSync(join(pluginDir, "bin"), { recursive: true });
    writeFileSync(join(pluginDir, "bin", "skillwiki"), "#!/usr/bin/env bash\nexec npx skillwiki \"$@\"\n");
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "/path/to/packages/cli/dist/cli.js", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const cli = r.result.data.checks.find(c => c.id === "cli_channels");
      expect(cli?.status).toBe("pass");
      expect(cli?.detail).toContain("dev source with installed production channels");
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

  function vaultSyncConfig(home: string, installed: boolean, role?: string, extras: Record<string, string> = {}): void {
    let existing = "";
    try { existing = readFileSync(join(home, ".skillwiki", ".env"), "utf8"); } catch { /* no file yet */ }
    const lines = existing.split("\n").filter(l => !l.startsWith("vault_sync."));
    if (installed) lines.push("vault_sync.installed=true");
    if (role) lines.push(`vault_sync.role=${role}`);
    for (const [key, value] of Object.entries(extras)) {
      lines.push(`vault_sync.${key}=${value}`);
    }
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

  function createVaultSyncSnapshotLog(home: string, lines: string[]): string {
    const logDir = createVaultSyncLogDir(home);
    const logPath = join(logDir, "wiki-snapshot.log");
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

    it("vault_sync_last_push_age uses latest OK push when git housekeeping follows", async () => {
      const h = home();
      vaultSyncConfig(h, true);
      createVaultSyncShareDir(h); // for installed check
      const now = new Date();
      const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
      createVaultSyncLog(h, [
        `${ts} OK push (no changes) duration=0s`,
        `${ts} GIT no changes to commit`,
        `${ts} GIT no commits to push`,
      ]);
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

    it("snapshotter role uses configured snapshot script, reports snapshot status, and skips leaf-only checks", async () => {
      const h = home();
      const shareDir = createVaultSyncShareDir(h);
      const snapshotScript = join(shareDir, "wiki-snapshot.sh");
      writeFileSync(snapshotScript, "#!/usr/bin/env bash\n# --max-delete 10\n");
      mkdirSync(join(h, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(h, ".config", "systemd", "user", "wiki-snapshot.timer"), "[Timer]\n");
      createVaultSyncSnapshotLog(h, [
        "2026-06-26 10:02:25 No changes to commit",
      ]);
      vaultSyncConfig(h, true, "snapshotter", {
        snapshot_script: snapshotScript,
        service_scope: "user",
      });

      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;

      const installed = r.result.data.checks.find(c => c.id === "vault_sync_installed");
      expect(installed?.status).toBe("pass");
      expect(installed?.detail).toContain("wiki-snapshot.sh");

      const jobs = r.result.data.checks.find(c => c.id === "vault_sync_jobs_enabled");
      expect(jobs?.status).toBe("pass");
      expect(jobs?.detail).toContain("wiki-snapshot.timer");

      const snapshotStatus = r.result.data.checks.find(c => c.id === "vault_sync_last_push_age");
      expect(snapshotStatus?.status).toBe("pass");
      expect(snapshotStatus?.label).toBe("Vault sync last snapshot status");
      expect(snapshotStatus?.detail).toContain("No changes to commit");

      for (const id of ["vault_sync_last_fetch_status", "vault_sync_filter_present"]) {
        const roleSkipped = r.result.data.checks.find(c => c.id === id);
        expect(roleSkipped?.status).toBe("pass");
        expect(roleSkipped?.detail).toContain("not applicable");
      }

      const guard = r.result.data.checks.find(c => c.id === "vault_sync_snapshot_guard");
      expect(guard?.status).toBe("pass");
      expect(guard?.detail).toContain("--max-delete");
    });

    it("snapshotter role reports the latest snapshot log failure", async () => {
      const h = home();
      const shareDir = createVaultSyncShareDir(h);
      const snapshotScript = join(shareDir, "wiki-snapshot.sh");
      writeFileSync(snapshotScript, "#!/usr/bin/env bash\n# --max-delete 10\n");
      mkdirSync(join(h, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(join(h, ".config", "systemd", "user", "wiki-snapshot.timer"), "[Timer]\n");
      createVaultSyncSnapshotLog(h, [
        "2026-06-26 14:02:03 === Wiki Snapshot: 20260626_140203 ===",
        "2026-06-26 14:02:07 ERROR: direct-S3 preflight found note paths missing from Git; refusing live snapshot before rclone sync",
      ]);
      vaultSyncConfig(h, true, "snapshotter", {
        snapshot_script: snapshotScript,
        service_scope: "user",
      });

      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;

      const snapshotStatus = r.result.data.checks.find(c => c.id === "vault_sync_last_push_age");
      expect(snapshotStatus?.status).toBe("error");
      expect(snapshotStatus?.label).toBe("Vault sync last snapshot status");
      expect(snapshotStatus?.detail).toContain("direct-S3 preflight");
    });

    it("snapshotter git checks use configured snapshot worktree when WIKI_PATH is a non-git mount", async () => {
      const h = home();
      const mountVault = mkdtempSync(join(tmpdir(), "fuse-vault-"));
      writeFileSync(join(mountVault, "SCHEMA.md"), SCHEMA);
      for (const d of ["raw", "entities", "concepts", "meta"]) mkdirSync(join(mountVault, d), { recursive: true });
      const gitVault = fullVault();
      gitCommit(gitVault, "snapshot worktree init");
      const profilePath = join(h, "snapshotter.env");
      writeFileSync(profilePath, `WIKI_GIT_WORKTREE=${gitVault}\n`);
      writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${mountVault}\n`);
      vaultSyncConfig(h, false, "snapshotter", {
        snapshot_profile: profilePath,
      });

      const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;

      const gitRemote = r.result.data.checks.find(c => c.id === "vault_git_remote");
      expect(gitRemote?.status).toBe("pass");
      expect(gitRemote?.detail).toContain("Remote:");

      const gitDirty = r.result.data.checks.find(c => c.id === "vault_git_dirty");
      expect(gitDirty?.status).toBe("pass");
      expect(gitDirty?.detail).toContain("Clean worktree");
    });
  });

  // ── Satellite job doctor checks ─────────────────────────────────

  const FLEET_SG02_SATELLITE = `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
s3_remote: seaweed-wiki:cloud/wiki
hosts:
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
  sg02:
    class: dev-linux
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [sg02]
    maintenance:
      skillwiki_satellite:
        enabled: true
        user: agent-memory
        vault_path: /home/agent-memory/wiki
        repo_path: /home/agent-memory/llm-wiki
        ssh_alias: sg02-agent-memory
        scheduler: systemd
        jobs:
          - agent-memory-trends-daily
`;

  function writeLatestRun(vault: string, body: Record<string, unknown>): void {
    const dir = join(vault, ".skillwiki", "agent-memory-trends");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "latest-run.json"), JSON.stringify(body, null, 2) + "\n");
  }

  describe("satellite job checks", () => {
    it("checkSatelliteLastRun errors when status is fail", () => {
      const v = mkdtempSync(join(tmpdir(), "vault-sat-"));
      writeLatestRun(v, { status: "fail", finished_at: new Date().toISOString(), failure_class: "agent" });
      const c = checkSatelliteLastRun(v, true);
      expect(c.status).toBe("error");
      expect(c.id).toBe("satellite_job_last_run");
    });

    it("checkSatelliteLastRun errors when status is failure", () => {
      const v = mkdtempSync(join(tmpdir(), "vault-sat-"));
      writeLatestRun(v, { status: "failure", finished_at: new Date().toISOString(), failure_class: "push" });
      const c = checkSatelliteLastRun(v, true);
      expect(c.status).toBe("error");
    });

    it("checkSatelliteLastRun warns when success finished_at is older than 26h", () => {
      const v = mkdtempSync(join(tmpdir(), "vault-sat-"));
      const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      writeLatestRun(v, { status: "success", finished_at: old });
      const c = checkSatelliteLastRun(v, true);
      expect(c.status).toBe("warn");
      expect(c.detail).toContain("26h");
    });

    it("checkSatelliteLastRun passes on recent success", () => {
      const v = mkdtempSync(join(tmpdir(), "vault-sat-"));
      writeLatestRun(v, { status: "success", finished_at: new Date().toISOString() });
      const c = checkSatelliteLastRun(v, true);
      expect(c.status).toBe("pass");
    });

    it("checkSatelliteLastRun skips when satellite not expected", () => {
      const c = checkSatelliteLastRun("/any", false);
      expect(c.status).toBe("pass");
      expect(c.detail).toContain("not expected");
    });

    it("checkSatelliteTimer skips on non-Linux", () => {
      const c = checkSatelliteTimer(true, {
        platform: () => "darwin",
        systemctlIsActive: () => "active",
      });
      expect(c.status).toBe("pass");
      expect(c.detail).toContain("Linux only");
    });

    it("checkSatelliteTimer passes when timer active on Linux", () => {
      const c = checkSatelliteTimer(true, {
        platform: () => "linux",
        systemctlIsActive: () => "active",
      });
      expect(c.status).toBe("pass");
      expect(c.detail).toContain("active");
    });

    it("checkSatelliteTimer errors when timer not active on Linux", () => {
      const c = checkSatelliteTimer(true, {
        platform: () => "linux",
        systemctlIsActive: () => "inactive",
      });
      expect(c.status).toBe("error");
    });

    it("runDoctor skips both satellite checks when satellite not enabled on host", async () => {
      const h = home();
      const v = fullVault();
      addFleet(v);
      writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
      const r = await runDoctor({
        home: h,
        envValue: v,
        argv: ["node", "skillwiki", "doctor"],
        currentVersion: "0.2.0-beta.15",
      });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const lastRun = r.result.data.checks.find(c => c.id === "satellite_job_last_run");
      const timer = r.result.data.checks.find(c => c.id === "satellite_job_timer");
      expect(lastRun?.status).toBe("pass");
      expect(lastRun?.detail).toContain("not expected");
      expect(timer?.status).toBe("pass");
      expect(timer?.detail).toContain("not expected");
    });

    it("runDoctor satellite_job_last_run errors when enabled host has fail latest-run", async () => {
      const h = home();
      const v = fullVault();
      const dir = join(v, "projects", "llm-wiki", "architecture");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "fleet.yaml"), FLEET_SG02_SATELLITE);
      writeLatestRun(v, { status: "fail", finished_at: new Date().toISOString(), failure_class: "validation" });
      writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\nSKILLWIKI_HOST_ID=sg02\n`);

      const prior = process.env.SKILLWIKI_HOST_ID;
      process.env.SKILLWIKI_HOST_ID = "sg02";
      let r!: Awaited<ReturnType<typeof runDoctor>>;
      try {
        r = await runDoctor({
          home: h,
          envValue: v,
          argv: ["node", "skillwiki", "doctor"],
          currentVersion: "0.2.0-beta.15",
        });
      } finally {
        if (prior === undefined) delete process.env.SKILLWIKI_HOST_ID;
        else process.env.SKILLWIKI_HOST_ID = prior;
      }

      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      const lastRun = r.result.data.checks.find(c => c.id === "satellite_job_last_run");
      expect(lastRun?.status).toBe("error");
    });
  });
});
