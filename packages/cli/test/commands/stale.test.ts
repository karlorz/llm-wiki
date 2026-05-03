import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStale } from "../../src/commands/stale.js";

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["concepts", "raw/articles"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

function pageFM(updated: string, sources: string[]): string {
  return `---
title: t
type: concept
tags: []
sources:
${sources.map(s => `  - ${s}`).join("\n")}
provenance: research
created: ${updated}
updated: ${updated}
---

body
`;
}

function rawFM(ingested: string): string {
  return `---
title: raw
url: https://example.com/x
type: raw
ingested: ${ingested}
sha256: 0000000000000000000000000000000000000000000000000000000000000000
---

raw body
`;
}

describe("runStale", () => {
  it("clean when gap <= threshold", async () => {
    const v = vault();
    writeFileSync(join(v, "raw", "articles", "src.md"), rawFM("2026-04-01"));
    writeFileSync(join(v, "concepts", "p.md"), pageFM("2026-03-15", ["raw/articles/src.md"]));
    const r = await runStale({ vault: v, days: 90 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.stale).toEqual([]);
  });

  it("flags pages whose updated lags newest source ingested by > days", async () => {
    const v = vault();
    writeFileSync(join(v, "raw", "articles", "src.md"), rawFM("2026-05-01"));
    writeFileSync(join(v, "concepts", "p.md"), pageFM("2025-12-01", ["raw/articles/src.md"]));
    const r = await runStale({ vault: v, days: 30 });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      expect(r.result.data.stale.length).toBe(1);
      expect(r.result.data.stale[0].page).toBe("concepts/p.md");
    }
  });

  it("page with no sources is clean", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "p.md"), pageFM("2020-01-01", []));
    const r = await runStale({ vault: v, days: 30 });
    expect(r.exitCode).toBe(0);
  });
});
