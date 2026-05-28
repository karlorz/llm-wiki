import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPathTooLong, truncateFilename } from "../../src/commands/path-too-long.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-pl-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("runPathTooLong", () => {
  it("reports zero violations for clean vault", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "short.md"), "---\ntitle: t\n---\n\nbody\n");
    const r = await runPathTooLong({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.violations).toHaveLength(0);
    }
  });

  it("detects files with paths exceeding 240 chars", async () => {
    const v = vault();
    const longName = "a".repeat(229) + ".md"; // concepts/ (9) + 229 + 3 = 241
    const relPath = `concepts/${longName}`;
    writeFileSync(join(v, relPath), "---\ntitle: t\n---\n\nbody\n");

    const r = await runPathTooLong({ vault: v });
    expect(r.exitCode).toBe(23); // LINT_HAS_ERRORS
    if (r.result.ok) {
      expect(r.result.data.violations).toHaveLength(1);
      expect(r.result.data.violations[0]!.relPath).toBe(relPath);
      expect(r.result.data.violations[0]!.length).toBe(241);
    }
  });

  it("includes both raw and typed pages in scan", async () => {
    const v = vault();
    const longName = "b".repeat(229) + ".md";
    writeFileSync(join(v, "concepts", longName), "---\ntitle: t\n---\n\nbody\n");
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    const rawName = "c".repeat(229) + ".md";
    // raw/articles/ (13) + 229 + 3 = 245
    writeFileSync(join(v, "raw", "articles", rawName), "---\nsource_url: https://example.com\ningested: 2026-05-01\nsha256: abc\n---\n\nbody\n");

    const r = await runPathTooLong({ vault: v });
    if (r.result.ok) {
      expect(r.result.data.violations.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("truncateFilename", () => {
  it("returns path unchanged when under the limit", () => {
    const path = "concepts/short.md";
    expect(truncateFilename(path)).toBe(path);
  });

  it("returns path unchanged at exactly the limit", () => {
    const name = "x".repeat(228); // concepts/ (9) + 228 + 3 = 240
    const path = `concepts/${name}.md`;
    expect(path.length).toBe(240);
    expect(truncateFilename(path)).toBe(path);
  });

  it("truncates filename that exceeds the limit", () => {
    const name = "y".repeat(250) + ".md"; // concepts/ (9) + 250 + 3 = 262
    const path = `concepts/${name}`;
    const result = truncateFilename(path);
    expect(result.length).toBeLessThanOrEqual(240);
    expect(result).toMatch(/^concepts\/y{1,}-\w{8}\.md$/);
    expect(result).not.toBe(path);
  });

  it("preserves .md extension in truncated filename", () => {
    const name = "z".repeat(300) + ".md";
    const path = `concepts/${name}`;
    const result = truncateFilename(path);
    expect(result).toMatch(/\.md$/);
    expect(result.length).toBeLessThanOrEqual(240);
  });

  it("produces deterministic output for same input", () => {
    const path = "raw/articles/long-article-title.md".repeat(5) + "extra.md";
    const a = truncateFilename(path);
    const b = truncateFilename(path);
    expect(a).toBe(b);
  });

  it("produces different outputs for different inputs", () => {
    const a = truncateFilename("concepts/" + "a".repeat(250) + ".md");
    const b = truncateFilename("concepts/" + "b".repeat(250) + ".md");
    expect(a).not.toBe(b);
  });

  it("handles paths without directory prefix", () => {
    const name = "w".repeat(250) + ".md";
    const result = truncateFilename(name);
    expect(result.length).toBeLessThanOrEqual(240);
    expect(result).toMatch(/\.md$/);
  });

  it("uses custom maxLength parameter", () => {
    const path = "concepts/medium-name.md";
    const result = truncateFilename(path, 20);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});
