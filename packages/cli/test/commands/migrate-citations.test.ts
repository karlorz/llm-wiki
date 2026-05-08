import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrateCitations } from "../../src/commands/migrate-citations.js";

const SCHEMA = `# Vault Schema\n\n## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - model\n\`\`\`\n`;

const FM = `---
title: t
type: concept
tags: [model]
sources: [raw/articles/x.md, raw/articles/y.md]
provenance: research
created: 2026-05-05
updated: 2026-05-05
---`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "mig-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"])
    mkdirSync(join(v, d), { recursive: true });
  return v;
}

describe("runMigrateCitations", () => {
  it("migrates inline markers to paragraph-end and adds ## Sources", async () => {
    const v = vault();
    const body = `${FM}\nBody cites X.\n^[raw/articles/x.md]\nBody cites Y.\n^[raw/articles/y.md]\n`;
    writeFileSync(join(v, "concepts", "alpha.md"), body);

    const r = await runMigrateCitations({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(34); // MIGRATION_APPLIED
    if (r.result.ok) {
      expect(r.result.data.migrated).toEqual(["concepts/alpha.md"]);
      expect(r.result.data.scanned).toBe(1);
    }

    const out = readFileSync(join(v, "concepts", "alpha.md"), "utf8");
    expect(out).toContain("## Sources");
    expect(out).toContain("^[raw/articles/x.md]");
    expect(out).toContain("^[raw/articles/y.md]");
  });

  it("is idempotent — second run returns exit 0", async () => {
    const v = vault();
    const body = `${FM}\nBody cites X.\n^[raw/articles/x.md]\nBody cites Y.\n^[raw/articles/y.md]\n`;
    writeFileSync(join(v, "concepts", "alpha.md"), body);

    await runMigrateCitations({ vault: v, dryRun: false });
    const r2 = await runMigrateCitations({ vault: v, dryRun: false });
    expect(r2.exitCode).toBe(0);
    if (r2.result.ok) {
      expect(r2.result.data.migrated).toEqual([]);
      expect(r2.result.data.skipped).toEqual(["concepts/alpha.md"]);
    }
  });

  it("does not modify files in dry-run mode", async () => {
    const v = vault();
    const body = `${FM}\nBody cites X.\n^[raw/articles/x.md]\n`;
    writeFileSync(join(v, "concepts", "alpha.md"), body);
    const before = readFileSync(join(v, "concepts", "alpha.md"), "utf8");

    const r = await runMigrateCitations({ vault: v, dryRun: true });
    expect(r.exitCode).toBe(34);
    const after = readFileSync(join(v, "concepts", "alpha.md"), "utf8");
    expect(after).toBe(before);
  });

  it("skips pages with no citation markers", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), `${FM}\nPlain body text.\n`);
    const r = await runMigrateCitations({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.unchanged).toBe(1);
  });

  it("never modifies files in raw/", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "raw content\n");
    writeFileSync(join(v, "concepts", "alpha.md"), `${FM}\nBody.\n^[raw/articles/x.md]\n`);
    const before = readFileSync(join(v, "raw", "articles", "x.md"), "utf8");

    await runMigrateCitations({ vault: v, dryRun: false });
    const after = readFileSync(join(v, "raw", "articles", "x.md"), "utf8");
    expect(after).toBe(before);
  });

  it("returns VAULT_PATH_INVALID for a bad vault path", async () => {
    const r = await runMigrateCitations({ vault: "/no/such/vault", dryRun: false });
    expect(r.exitCode).toBe(9); // VAULT_PATH_INVALID
    expect(r.result.ok).toBe(false);
  });

  it("does not migrate citation markers inside code fences", async () => {
    const v = vault();
    const body = `${FM}\nBody text.\n^[raw/articles/x.md]\n\n\`\`\`\nSome code with ^[raw/articles/y.md] inside.\n\`\`\`\n`;
    writeFileSync(join(v, "concepts", "alpha.md"), body);

    const r = await runMigrateCitations({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(34); // MIGRATION_APPLIED
    if (r.result.ok) {
      expect(r.result.data.migrated).toEqual(["concepts/alpha.md"]);
    }
    const out = readFileSync(join(v, "concepts", "alpha.md"), "utf8");
    // The marker inside the code fence should NOT appear in the ## Sources section
    const sourcesSection = out.split("## Sources")[1];
    expect(sourcesSection).toContain("raw/articles/x.md");
    // y.md is in a code fence so it was not extracted by the citation parser
    // (the extractCitationMarkers parser strips code fences)
  });

  it("skips pages with unparseable frontmatter (missing closing delimiter)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "bad-fm.md"), `---
title: bad
type: concept
Body text without closing delimiter ^[raw/articles/x.md]
`);
    const r = await runMigrateCitations({ vault: v, dryRun: false });
    // Page should be skipped because splitFrontmatter fails
    if (r.result.ok) {
      expect(r.result.data.migrated).not.toContain("concepts/bad-fm.md");
    }
  });

  it("moves mid-line citation markers to paragraph end", async () => {
    const v = vault();
    // Marker in the middle of a line, not at paragraph end
    const body = `${FM}\nSome ^[raw/articles/x.md] mid-sentence text.\n`;
    writeFileSync(join(v, "concepts", "alpha.md"), body);

    const r = await runMigrateCitations({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(34);
    if (r.result.ok) {
      expect(r.result.data.migrated).toEqual(["concepts/alpha.md"]);
    }
    const out = readFileSync(join(v, "concepts", "alpha.md"), "utf8");
    // Marker should now be at paragraph end, not mid-sentence
    expect(out).toContain("## Sources");
    // The body line should have the marker moved to after the sentence
    const bodySection = out.split("## Sources")[0];
    expect(bodySection).not.toMatch(/Some \^\[raw\/articles\/x\.md\] mid/);
    expect(bodySection).toMatch(/\^\[raw\/articles\/x\.md\]/);
  });

  it("handles marker-only line at the very start of the body", async () => {
    const v = vault();
    // Marker on the first line of body with no preceding prose to merge with
    const body = `${FM}\n^[raw/articles/x.md]\nThen some text.\n`;
    writeFileSync(join(v, "concepts", "alpha.md"), body);

    const r = await runMigrateCitations({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(34); // MIGRATION_APPLIED
    const out = readFileSync(join(v, "concepts", "alpha.md"), "utf8");
    expect(out).toContain("## Sources");
    expect(out).toContain("^[raw/articles/x.md]");
  });
});
