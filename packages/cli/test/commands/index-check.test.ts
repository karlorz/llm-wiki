import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexCheck } from "../../src/commands/index-check.js";

function v(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["entities", "concepts", "comparisons", "queries"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

describe("runIndexCheck", () => {
  it("clean: every file is in the index, every index entry resolves", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n\n## Concepts\n- [[alpha]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
  });

  it("missing from index -> exit 18", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toContain("concepts/alpha.md");
    }
  });

  it("ghost entry (index points to nonexistent slug) -> exit 18", async () => {
    const dir = v();
    writeFileSync(join(dir, "index.md"), `# Index\n\n## Concepts\n- [[ghost]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.ghost_entries).toContain("ghost");
    }
  });

  it("matches index entries case-insensitively", async () => {
    const dir = v();
    writeFileSync(join(dir, "entities", "c929.md"), `---
title: C929
created: 2026-01-01
updated: 2026-01-01
type: entity
tags: []
sources: []
---

# C929
`);
    writeFileSync(join(dir, "index.md"), "# Index\n\n- [[C929]] — widebody\n");
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toHaveLength(0);
      expect(r.result.data.ghost_entries).toHaveLength(0);
    }
  });
});
