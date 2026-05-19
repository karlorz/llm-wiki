import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRawBodyDedup } from "../../src/commands/raw-body-dedup.js";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "articles"), { recursive: true });
  return dir;
}

function rawFile(sha256: string, body: string) {
  return `---
type: raw
sha256: ${sha256}
ingested: "2026-05-19"
---

${body}`;
}

describe("runRawBodyDedup", () => {
  it("returns empty when no duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile("a".repeat(64), "body one"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile("b".repeat(64), "body two"));
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates).toEqual([]);
      expect(r.result.data.scanned).toBe(2);
    }
  });

  it("detects identical body with different frontmatter SHA256", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile("a".repeat(64), "same article body content"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile("b".repeat(64), "same article body content"));
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(1);
      expect(r.result.data.duplicates[0]!.files.length).toBe(2);
      const paths = r.result.data.duplicates[0]!.files.map(f => f.relPath);
      expect(paths).toContain("raw/articles/canonical.md");
      expect(paths).toContain("raw/articles/dup.md");
    }
  });

  it("does NOT flag same body + same SHA256 (existing dedup covers this)", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile("a".repeat(64), "same body"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile("a".repeat(64), "same body"));
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates).toEqual([]);
    }
  });

  it("detects identical body when all frontmatter SHA256s are missing", async () => {
    const dir = makeVault();
    const rawWithoutSha = (body: string) => `---
type: raw
ingested: "2026-05-19"
---

${body}`;
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawWithoutSha("same body"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawWithoutSha("same body"));
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(1);
      expect(r.result.data.duplicates[0]!.files.map(f => f.sha256)).toEqual([null, null]);
    }
  });

  it("handles empty vault gracefully", async () => {
    const dir = makeVault();
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates).toEqual([]);
      expect(r.result.data.scanned).toBe(0);
    }
  });

  it("groups 3+ files with identical body", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile("a".repeat(64), "triplicate body"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile("b".repeat(64), "triplicate body"));
    writeFileSync(join(dir, "raw", "articles", "c.md"), rawFile("c".repeat(64), "triplicate body"));
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(1);
      expect(r.result.data.duplicates[0]!.files.length).toBe(3);
    }
  });

  it("handles raw files without frontmatter delimiter", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "broken.md"), "not valid yaml\n---\nbody content");
    writeFileSync(join(dir, "raw", "articles", "ok.md"), rawFile("a".repeat(64), "body content"));
    const r = await runRawBodyDedup(dir);
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(2);
    }
  });

  it("returns VAULT_PATH_INVALID for invalid vaults", async () => {
    const r = await runRawBodyDedup(join(tmpdir(), "missing-vault"));
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe("VAULT_PATH_INVALID");
  });
});
