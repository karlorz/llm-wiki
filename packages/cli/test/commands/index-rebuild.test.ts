import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runIndexRebuild } from "../../src/commands/index-rebuild.js";

const FM = (title: string, type: string) => `---
title: ${title}
type: ${type}
tags: []
sources: [raw/articles/seed.md]
provenance: research
created: 2026-07-15
updated: 2026-07-15
---

# ${title}
`;

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "index-rebuild-"));
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  writeFileSync(join(vault, "concepts", "alpha.md"), FM("Alpha Concept", "concept"));
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Concepts\n- [[concepts/alpha]] — old\n");
  execFileSync("git", ["init"], { cwd: vault });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: vault });
  execFileSync("git", ["config", "user.name", "t"], { cwd: vault });
  execFileSync("git", ["add", "."], { cwd: vault });
  execFileSync("git", ["commit", "-m", "init"], { cwd: vault });
  return vault;
}

describe("runIndexRebuild", () => {
  it("preview is read-only; write is byte-idempotent", async () => {
    const vault = makeVault();
    const indexPath = join(vault, "index.md");
    const original = readFileSync(indexPath, "utf8");

    const preview = await runIndexRebuild({ vault, write: false });
    expect(preview.result).toMatchObject({ ok: true, data: { changed: true, dry_run: true } });
    expect(readFileSync(indexPath, "utf8")).toBe(original);

    const first = await runIndexRebuild({ vault, write: true });
    const firstStat = statSync(indexPath);
    const firstBytes = readFileSync(indexPath, "utf8");
    const second = await runIndexRebuild({ vault, write: true });
    const secondStat = statSync(indexPath);
    expect(first.result).toMatchObject({ ok: true, data: { changed: true } });
    expect(second.result).toMatchObject({ ok: true, data: { changed: false } });
    expect(readFileSync(indexPath, "utf8")).toBe(firstBytes);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });
});
