import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDedup } from "../../src/commands/dedup.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "articles"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

function rawFile(hash: string, body: string) {
  return `---
type: raw
sha256: ${hash}
ingested: "2026-05-05"
---

${body}`;
}

describe("runDedup", () => {
  it("returns OK when no duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_B, "beta"));
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(0);
      expect(r.result.data.scanned).toBe(2);
    }
  });

  it("detects duplicate sha256 across files", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_A, "same body"));
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(33);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(1);
      expect(r.result.data.duplicates[0].files.length).toBe(2);
      expect(r.result.data.duplicates[0].sha256).toBe(HASH_A);
    }
  });

  it("skips raw files without valid sha256", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), `---
type: raw
ingested: "2026-05-05"
---

no hash`);
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.duplicates.length).toBe(0);
    }
  });

  it("returns 9 for invalid vault", async () => {
    const r = await runDedup({ vault: "/nonexistent" });
    expect(r.exitCode).toBe(9);
  });

  it("reports multiple duplicate groups", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "x"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_A, "x"));
    writeFileSync(join(dir, "raw", "articles", "c.md"), rawFile(HASH_B, "y"));
    writeFileSync(join(dir, "raw", "articles", "d.md"), rawFile(HASH_B, "y"));
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(33);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(2);
    }
  });

  it("apply rewires citations and removes duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "original"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "duplicate"));
    writeFileSync(join(dir, "concepts", "page.md"), `---
title: Test
type: concept
tags: [model]
sources:
  - "^[raw/articles/dup.md]"
---

Content citing duplicate.^[raw/articles/dup.md]
`);
    const r = await runDedup({ vault: dir, apply: true });
    expect(r.exitCode).toBe(36); // DEDUP_APPLIED
    if (r.result.ok) {
      expect(r.result.data.rewired).toContain("concepts/page.md");
      expect(r.result.data.removed).toContain("raw/articles/dup.md");
    }
    // Duplicate raw file deleted
    expect(existsSync(join(dir, "raw", "articles", "dup.md"))).toBe(false);
    // Canonical raw file preserved
    expect(existsSync(join(dir, "raw", "articles", "canonical.md"))).toBe(true);
    // Citations rewired
    const pageContent = readFileSync(join(dir, "concepts", "page.md"), "utf-8");
    expect(pageContent).toContain("^[raw/articles/canonical.md]");
    expect(pageContent).not.toContain("^[raw/articles/dup.md]");
  });

  it("apply exits OK when no duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    const r = await runDedup({ vault: dir, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.rewired).toEqual([]);
      expect(r.result.data.removed).toEqual([]);
    }
  });

  it("skips raw file with sha256 of wrong length", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "short.md"), `---
type: raw
sha256: abc123
ingested: "2026-05-05"
---

short hash`);
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.duplicates.length).toBe(0);
    }
  });

  it("skips raw file where sha256 is not a string type", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "numeric.md"), `---
type: raw
sha256: 999
ingested: "2026-05-05"
---

numeric hash`);
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.duplicates.length).toBe(0);
    }
  });
});
