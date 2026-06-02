import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixPathTooLong, runPathTooLong, truncateFilename } from "../../src/commands/path-too-long.js";

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

  it("includes archived markdown files in scan", async () => {
    const v = vault();
    const archiveDir = join(v, "_archive", "raw-dedup-2026-05-28", "articles");
    mkdirSync(archiveDir, { recursive: true });
    const longName = "archived-source-".repeat(13) + ".md";
    const relPath = `_archive/raw-dedup-2026-05-28/articles/${longName}`;
    writeFileSync(join(v, relPath), "---\ntitle: archived\n---\n\nbody\n");

    const r = await runPathTooLong({ vault: v });
    expect(r.exitCode).toBe(23);
    if (r.result.ok) {
      expect(r.result.data.violations.map(v => v.relPath)).toContain(relPath);
      expect(r.result.data.violations[0]!.suggestedRelPath.length).toBeLessThanOrEqual(240);
    }
  });
});

describe("fixPathTooLong", () => {
  it("renames long files and rewires index stem wikilinks", async () => {
    const v = vault();
    const longStem = "windows-hostile-long-note-name-".repeat(8);
    const relPath = `concepts/${longStem}.md`;
    writeFileSync(join(v, relPath), "---\ntitle: t\n---\n\nbody\n");
    writeFileSync(join(v, "index.md"), `# Index\n\n## Concepts\n- [[${longStem}]]\n`);

    const r = await fixPathTooLong({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.fixed).toHaveLength(1);
      const fixed = r.result.data.fixed[0]!;
      expect(fixed.from).toBe(relPath);
      expect(fixed.to.length).toBeLessThanOrEqual(240);
      expect(existsSync(join(v, fixed.from))).toBe(false);
      expect(existsSync(join(v, fixed.to))).toBe(true);

      const newStem = fixed.to.split("/").pop()!.replace(/\.md$/, "");
      const index = readFileSync(join(v, "index.md"), "utf8");
      expect(index).not.toContain(`[[${longStem}]]`);
      expect(index).toContain(`[[${newStem}]]`);
    }
  });

  it("dedupes to an existing identical shortened target instead of creating suffix variants", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles", "obsidian-import"), { recursive: true });
    const longStem = "duplicate-windows-hostile-note-name-".repeat(6);
    const relPath = `raw/articles/obsidian-import/${longStem}.md`;
    const preferred = truncateFilename(relPath);
    const content = "---\ntitle: t\n---\n\nsame body\n";
    writeFileSync(join(v, relPath), content);
    writeFileSync(join(v, preferred), content);
    writeFileSync(join(v, "index.md"), `# Index\n\n## Concepts\n- [[${longStem}]]\n`);

    const r = await fixPathTooLong({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.fixed).toEqual([{ from: relPath, to: preferred }]);
      expect(existsSync(join(v, relPath))).toBe(false);
      expect(existsSync(join(v, preferred))).toBe(true);
      const suffixVariant = preferred.replace(/\.md$/, "-2.md");
      expect(existsSync(join(v, suffixVariant))).toBe(false);

      const newStem = preferred.split("/").pop()!.replace(/\.md$/, "");
      const index = readFileSync(join(v, "index.md"), "utf8");
      expect(index).toContain(`[[${newStem}]]`);
    }
  });

  it("uses a suffix variant when the shortened target exists with different content", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles", "obsidian-import"), { recursive: true });
    const longStem = "collision-windows-hostile-note-name-".repeat(6);
    const relPath = `raw/articles/obsidian-import/${longStem}.md`;
    const preferred = truncateFilename(relPath);
    writeFileSync(join(v, relPath), "---\ntitle: t\n---\n\nsource body\n");
    writeFileSync(join(v, preferred), "---\ntitle: t\n---\n\ndifferent body\n");

    const r = await fixPathTooLong({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.fixed).toHaveLength(1);
      const fixed = r.result.data.fixed[0]!;
      expect(fixed.from).toBe(relPath);
      expect(fixed.to).not.toBe(preferred);
      expect(fixed.to.length).toBeLessThanOrEqual(240);
      expect(existsSync(join(v, preferred))).toBe(true);
      expect(readFileSync(join(v, preferred), "utf8")).toContain("different body");
      expect(readFileSync(join(v, fixed.to), "utf8")).toContain("source body");
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
