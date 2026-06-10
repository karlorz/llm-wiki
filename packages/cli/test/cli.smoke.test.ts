import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(__dirname, "..", "dist", "cli.js");

function run(args: string[], env: NodeJS.ProcessEnv = process.env): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8", env });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

const TMP_VAULT = mkdtempSync(join(tmpdir(), "smoke-vault-"));
const RICH_VAULT = mkdtempSync(join(tmpdir(), "smoke-rich-"));
afterAll(() => {
  // tmp dirs cleaned by OS; no explicit teardown needed
});

function setupTmpVault() {
  writeFileSync(join(TMP_VAULT, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(TMP_VAULT, "raw"), { recursive: true });
  mkdirSync(join(TMP_VAULT, "concepts"), { recursive: true });
  writeFileSync(join(TMP_VAULT, "index.md"), "# Index\n");
  writeFileSync(join(TMP_VAULT, "log.md"), "# Vault Log\n");
}

function setupRichVault() {
  writeFileSync(join(RICH_VAULT, "SCHEMA.md"), `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - model\n\`\`\`\n`);
  mkdirSync(join(RICH_VAULT, "raw"), { recursive: true });
  mkdirSync(join(RICH_VAULT, "concepts"), { recursive: true });
  writeFileSync(join(RICH_VAULT, "concepts", "test.md"), `---\ntitle: Test\ntype: concept\ntags: [model]\nsources: []\nprovenance: research\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n## Overview\n\nTest page [[test]].\n\n## Related\n\n- [[test]]\n`);
  writeFileSync(join(RICH_VAULT, "index.md"), "# Index\n\n## Concepts\n\n- [Test](concepts/test.md)\n");
  writeFileSync(join(RICH_VAULT, "log.md"), "# Vault Log\n");
}
setupTmpVault();
setupRichVault();

describe("cli smoke", () => {
  it("fetch-guard rejects http with exit 4", () => {
    const r = run(["fetch-guard", "http://example.com"]);
    expect(r.status).toBe(4);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("fetch-guard allows https with exit 0", () => {
    const r = run(["fetch-guard", "https://example.com"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.allowed).toBe(true);
  });

  it("--human flag does not change exit code", () => {
    const r = run(["fetch-guard", "http://example.com", "--human"]);
    expect(r.status).toBe(4);
    expect(r.stdout).toContain("SCHEME_REJECTED");
  });

  it("--human produces non-JSON output for path", () => {
    const json = run(["path"]);
    const human = run(["path", "--human"]);
    expect(json.status).toBe(human.status);
    expect(human.stdout).not.toBe(json.stdout);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.length).toBeGreaterThan(0);
  });

  it("--human produces non-JSON output for lang", () => {
    const json = run(["lang"]);
    const human = run(["lang", "--human"]);
    expect(json.status).toBe(human.status);
    expect(human.stdout).not.toBe(json.stdout);
    expect(() => JSON.parse(human.stdout)).toThrow();
  });

  it("--human produces non-JSON output for doctor", () => {
    const json = run(["doctor"]);
    const human = run(["doctor", "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.length).toBeGreaterThan(0);
  });

  it("unknown subcommand exits non-zero", () => {
    const r = run(["bogus"]);
    expect(r.status).not.toBe(0);
  });

  it("--human produces non-JSON output for lint", () => {
    const json = run(["lint", TMP_VAULT]);
    const human = run(["lint", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.length).toBeGreaterThan(0);
  });

  it("lint --summary emits bounded buckets without full item arrays", () => {
    const r = run(["lint", RICH_VAULT, "--summary"]);
    expect([0, 22, 23]).toContain(r.status);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.details_included).toBe(false);
    expect(parsed.data.by_severity).toBeUndefined();
    expect(Array.isArray(parsed.data.buckets)).toBe(true);
    expect(parsed.data.buckets.every((bucket: Record<string, unknown>) => !("items" in bucket))).toBe(true);
  });

  it("health --no-fail exits 0 while reporting status in JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "smoke-health-home-"));
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    const r = run(["health", RICH_VAULT, "--sync", "off", "--no-fail"], { ...process.env, HOME: home });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.schema_version).toBe(1);
    expect(parsed.data.components.lint.details_included).toBe(false);
    expect(parsed.data.components.vault_sync.blocking).toBe(false);
    expect(parsed.data.mutated).toBe(false);
    expect(parsed.data.post_commit_ran).toBe(false);
  });

  it("health --out does not trigger auto-commit even when report is inside the vault", () => {
    const acVault = mkdtempSync(join(tmpdir(), "smoke-health-ac-"));
    mkdirSync(join(acVault, "raw", "articles"), { recursive: true });
    mkdirSync(join(acVault, "concepts"), { recursive: true });
    writeFileSync(join(acVault, "SCHEMA.md"), "# Vault Schema\n\n## Tag Taxonomy\n\n```yaml\ntaxonomy:\n  - model\n```\n");
    writeFileSync(join(acVault, "index.md"), "# Index\n");
    writeFileSync(join(acVault, "log.md"), "# Vault Log\n");
    execFileSync("git", ["init", acVault], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "config", "user.email", "test@test.com"], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "config", "user.name", "Test"], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "commit", "-m", "init"], { encoding: "utf8" });

    const home = mkdtempSync(join(tmpdir(), "smoke-health-ac-home-"));
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    writeFileSync(join(home, ".skillwiki", ".env"), "AUTO_COMMIT=true\n");
    const out = join(acVault, "health.json");

    const r = run(["health", acVault, "--sync", "off", "--no-fail", "--out", out], { ...process.env, HOME: home });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.report_written).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8")).data.report_written).toBe(true);

    const log = execFileSync("git", ["-C", acVault, "log", "--oneline"], { encoding: "utf8" }).trim();
    expect(log.split("\n")).toHaveLength(1);
  });

  it("--human produces non-JSON output for graph", () => {
    const json = run(["graph", "build", TMP_VAULT]);
    const human = run(["graph", "build", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
  });

  it("--human produces non-JSON output for dedup", () => {
    const json = run(["dedup", TMP_VAULT]);
    const human = run(["dedup", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("duplicate");
  });

  it("--human produces non-JSON output for orphans", () => {
    const json = run(["orphans", TMP_VAULT]);
    const human = run(["orphans", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
  });

  it("--human produces non-JSON output for overlap", () => {
    const json = run(["overlap", TMP_VAULT]);
    const human = run(["overlap", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
  });

  it("--human produces non-JSON output for drift", () => {
    const json = run(["drift", TMP_VAULT]);
    const human = run(["drift", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
  });

  it("--human produces non-JSON output for audit", () => {
    const fixture = join(__dirname, "..", "test", "fixtures", "audit-vault", "concepts", "clean.md");
    const json = run(["audit", fixture]);
    const human = run(["audit", fixture, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.length).toBeGreaterThan(0);
  });

  it("--human produces non-JSON output for migrate-citations", () => {
    const json = run(["migrate-citations", TMP_VAULT]);
    const human = run(["migrate-citations", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("scanned");
  });

  it("--human produces non-JSON output for stale", () => {
    const json = run(["stale", TMP_VAULT]);
    const human = run(["stale", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("stale");
  });

  it("--human produces non-JSON output for pagesize", () => {
    const json = run(["pagesize", TMP_VAULT]);
    const human = run(["pagesize", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("size");
  });

  it("--human produces non-JSON output for log-rotate", () => {
    const json = run(["log-rotate", TMP_VAULT]);
    const human = run(["log-rotate", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("rotation");
  });

  it("--human produces non-JSON output for index-check", () => {
    const json = run(["index-check", TMP_VAULT]);
    const human = run(["index-check", TMP_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("index");
  });

  it("--human produces non-JSON output for tag-audit", () => {
    const json = run(["tag-audit", RICH_VAULT]);
    const human = run(["tag-audit", RICH_VAULT, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.toLowerCase()).toContain("tag");
  });

  it("--human produces non-JSON output for validate", () => {
    const fixture = join(RICH_VAULT, "concepts", "test.md");
    const json = run(["validate", fixture]);
    const human = run(["validate", fixture, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.length).toBeGreaterThan(0);
  });

  it("--human produces non-JSON output for hash", () => {
    const fixture = join(RICH_VAULT, "concepts", "test.md");
    const json = run(["hash", fixture]);
    const human = run(["hash", fixture, "--human"]);
    expect(json.status).toBe(human.status);
    expect(() => JSON.parse(human.stdout)).toThrow();
    expect(human.stdout.length).toBeGreaterThan(0);
  });

  it("auto-commits when AUTO_COMMIT=true is set", () => {
    const acVault = mkdtempSync(join(tmpdir(), "smoke-ac-"));
    mkdirSync(join(acVault, "raw", "articles"), { recursive: true });
    mkdirSync(join(acVault, "concepts"), { recursive: true });
    writeFileSync(join(acVault, "SCHEMA.md"), "# Vault Schema\n\n## Tag Taxonomy\n\n```yaml\ntaxonomy:\n  - model\n```\n");
    writeFileSync(join(acVault, "index.md"), "# Index\n");
    writeFileSync(join(acVault, "log.md"), "# Vault Log\n");
    execFileSync("git", ["init", acVault], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "config", "user.email", "test@test.com"], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "config", "user.name", "Test"], { encoding: "utf8" });
    writeFileSync(join(acVault, "README.md"), "# test\n");
    execFileSync("git", ["-C", acVault, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", acVault, "commit", "-m", "init"], { encoding: "utf8" });

    const acHome = mkdtempSync(join(tmpdir(), "smoke-ac-home-"));
    mkdirSync(join(acHome, ".skillwiki"), { recursive: true });
    writeFileSync(join(acHome, ".skillwiki", ".env"), "AUTO_COMMIT=true\n");

    const seedOut = execFileSync("node", [BIN, "seed", acVault], {
      encoding: "utf8",
      env: { ...process.env, HOME: acHome },
    });
    const parsed = JSON.parse(seedOut);
    expect(parsed.ok).toBe(true);

    const log = execFileSync("git", ["-C", acVault, "log", "--oneline"], { encoding: "utf8" }).trim();
    expect(log).toContain("seed:");
  });
});
