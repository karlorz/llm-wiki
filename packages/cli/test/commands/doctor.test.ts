import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("vault missing subdirs gives error for vault_structure", async () => {
    const h = home();
    const v = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(h, ".skillwiki", ".env"), `WIKI_PATH=${v}\n`);
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const vs = r.result.data.checks.find(c => c.id === "vault_structure");
      expect(vs?.status).toBe("error");
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

  it("always returns exactly 8 checks", async () => {
    const h = home();
    const r = await runDoctor({ home: h, envValue: undefined, argv: ["node", "skillwiki", "doctor"], currentVersion: "0.2.0-beta.15" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.checks).toHaveLength(8);
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
});
