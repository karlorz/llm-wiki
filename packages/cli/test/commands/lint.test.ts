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
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "## Overview\n\nContent about alpha [[alpha]].\n\n## Details\n\nMore details here.\n\n## Related\n\n- [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBe(0);
      expect(r.result.data.summary.warnings).toBe(0);
      expect(r.result.data.summary.info).toBe(0);
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

  it("does not produce topic_map_recommended for small vaults", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("topic_map_recommended");
    }
  });

  it("warns on legacy citation style pages", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body cites X.\n^[raw/articles/x.md]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("legacy_citation_style");
    }
  });

  it("warns on orphaned citations after Sources section", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    // Citation marker after blank line in Sources section = orphaned
    const body = "Body cites X. ^[raw/articles/x.md]\n\n## Sources\n- ^[raw/articles/x.md]\n\n\n^[raw/articles/x.md]\n";
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("orphaned_citations");
    }
  });

  it("flags thin pages missing structural sections as page_structure", async () => {
    const v = vault();
    // Page with no Overview, no Related, only 1 section — under 60 lines
    writeFileSync(join(v, "concepts", "thin.md"), FM(["model"]) + "Just a short body.\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[thin]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22); // info counts as LINT_HAS_WARNINGS
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).toContain("page_structure");
    }
  });

  it("accepts ## Relationships as alias for ## Related", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "## Overview\n\nContent.\n\n## Details\n\nMore.\n\n## Relationships\n\n- [[beta]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("page_structure");
    }
  });

  it("warns on duplicate frontmatter blocks", async () => {
    const v = vault();
    // Page with two frontmatter blocks (e.g., from a bad edit that prepended a new block)
    const dup = `---
title: first
type: concept
tags: [model]
---
title: second
type: concept
tags: [model]
---

## Overview

Content.
`;
    writeFileSync(join(v, "concepts", "dup.md"), dup);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[dup]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("duplicate_frontmatter");
    }
  });
});
