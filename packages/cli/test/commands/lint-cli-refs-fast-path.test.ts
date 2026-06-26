import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const archiveReads = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(async (path: Parameters<typeof actual.readdir>[0], options?: Parameters<typeof actual.readdir>[1]) => {
      const asString = String(path);
      if (asString.includes("_archive")) archiveReads.paths.push(asString);
      return actual.readdir(path, options as never);
    }),
  };
});

const { runLint } = await import("../../src/commands/lint.js");

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

const FM = `---
title: t
type: concept
tags: [model]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("runLint cli_refs fast path", () => {
  it("does not read archive directories for cli_refs-only lint", async () => {
    archiveReads.paths = [];
    const v = vault();
    mkdirSync(join(v, "_archive", "queries"), { recursive: true });
    writeFileSync(
      join(v, "_archive", "queries", "archived-cli-ref.md"),
      "Archived note: `skillwiki frobnicate`.\n"
    );
    writeFileSync(
      join(v, "concepts", "valid.md"),
      FM + "> **TL;DR:** valid\n\n## Overview\n\nNo command refs here.\n\n## Details\n\nText.\n\n## Related\n\n- [[valid]]\n"
    );

    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "cli_refs" });

    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    expect(archiveReads.paths).toEqual([]);
  });
});
