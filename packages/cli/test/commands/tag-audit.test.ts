import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTagAudit } from "../../src/commands/tag-audit.js";

const SCHEMA_OK = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
  - person
\`\`\`
`;

function v(schema = SCHEMA_OK): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), schema);
  for (const d of ["entities", "concepts", "comparisons", "queries"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const FM = (tags: string[]) => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

body
`;

describe("runTagAudit", () => {
  it("clean -> exit 0", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "a.md"), FM(["model"]));
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(0);
  });

  it("tag not in taxonomy -> exit 17", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "a.md"), FM(["model", "rogue"]));
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(17);
    if (r.result.ok) {
      expect(r.result.data.violations.some(v => v.tag === "rogue")).toBe(true);
    }
  });

  it("missing taxonomy block -> exit 7 (NO_TAXONOMY_BLOCK)", async () => {
    const dir = v("# Vault Schema\n");
    writeFileSync(join(dir, "concepts", "a.md"), FM(["model"]));
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(7);
  });

  it("malformed taxonomy YAML -> exit 7 (INVALID_FRONTMATTER)", async () => {
    const dir = v("## Tag Taxonomy\n\n```yaml\ntaxonomy:\n  - [unbalanced\n```\n");
    const r = await runTagAudit({ vault: dir });
    expect(r.exitCode).toBe(7);
  });
});
