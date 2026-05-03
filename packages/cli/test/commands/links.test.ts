import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLinks } from "../../src/commands/links.js";

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

const FM = `---
title: page
type: concept
tags: [model]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

describe("runLinks", () => {
  it("clean vault exits 0", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM + "See [[beta]].\n");
    writeFileSync(join(v, "concepts", "beta.md"), FM + "Refers to [[alpha]].\n");
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.broken).toEqual([]);
  });

  it("broken wikilink -> BROKEN_WIKILINKS exit 16", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM + "See [[ghost]].\n");
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(16);
    if (r.result.ok) {
      expect(r.result.data.broken.length).toBe(1);
      expect(r.result.data.broken[0].slug).toBe("ghost");
    }
  });

  it("self-reference resolves (own slug counts as a target)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM + "Self [[alpha]].\n");
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(0);
  });

  it("VAULT_PATH_INVALID (9) when vault has no SCHEMA.md", async () => {
    const v = mkdtempSync(join(tmpdir(), "novault-"));
    const r = await runLinks({ vault: v });
    expect(r.exitCode).toBe(9);
  });
});
