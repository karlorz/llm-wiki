import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(__dirname, "..", "dist", "cli.js");

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

const TMP_VAULT = mkdtempSync(join(tmpdir(), "smoke-vault-"));
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
setupTmpVault();

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
});
