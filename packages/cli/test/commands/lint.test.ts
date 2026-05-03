import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../../src/commands/lint.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

const FM = (tags: string[], updated = "2026-05-03") => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: ${updated}
updated: ${updated}
---

`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

describe("runLint", () => {
  it("clean fixture exits 0", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBe(0);
      expect(r.result.data.summary.warnings).toBe(0);
    }
  });

  it("warning-only fixture exits 22 (LINT_HAS_WARNINGS)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      expect(r.result.data.summary.warnings).toBeGreaterThan(0);
      expect(r.result.data.summary.errors).toBe(0);
    }
  });

  it("error fixture exits 23 (LINT_HAS_ERRORS)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["rogue"]) + "Body [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(23);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBeGreaterThan(0);
      const kinds = r.result.data.by_severity.error.map(e => e.kind);
      expect(kinds).toContain("tag_not_in_taxonomy");
    }
  });

  it("returns vault path + source in the envelope", async () => {
    const v = vault();
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      expect(r.result.data.vault.path).toBe(v);
      expect(r.result.data.vault.source).toBe("resolved");
    }
  });
});
