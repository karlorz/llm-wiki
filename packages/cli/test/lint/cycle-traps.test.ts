import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../../src/lint/runner.js";
import { cycleTrapsRule } from "../../src/lint/rules.js";
import { scanVault } from "../../src/utils/vault.js";
import { buildWikilinkResolver } from "../../src/utils/wikilink-resolver.js";
import { buildCliSurface } from "../../src/utils/cli-surface.js";
import type { LintRuleContext } from "../../src/lint/types.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

function createPageContent(title: string, bodyLinks: string[]): string {
  const linksText = bodyLinks.map((target) => `- [[${target}]]`).join("\n");
  return `---
title: ${title}
type: concept
tags: [model]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

## Overview

Overview for ${title}.

## Details

${linksText}
`;
}

function createFixtureVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-cycle-traps-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[a]]\n- [[b]]\n- [[c]]\n- [[d]]\n- [[e]]\n- [[f]]\n- [[g]]\n- [[h]]\n- [[orphan]]\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }

  // 2-cycle: a <-> b
  writeFileSync(join(v, "concepts", "a.md"), createPageContent("Page A", ["b"]));
  writeFileSync(join(v, "concepts", "b.md"), createPageContent("Page B", ["a"]));

  // 3-cycle: c -> d -> e -> c
  writeFileSync(join(v, "concepts", "c.md"), createPageContent("Page C", ["d"]));
  writeFileSync(join(v, "concepts", "d.md"), createPageContent("Page D", ["e"]));
  writeFileSync(join(v, "concepts", "e.md"), createPageContent("Page E", ["c"]));

  // Self-link (1-cycle): f -> f
  writeFileSync(join(v, "concepts", "f.md"), createPageContent("Page F", ["f"]));

  // Acyclic control pages: g -> h, h has no outlinks
  writeFileSync(join(v, "concepts", "g.md"), createPageContent("Page G", ["h"]));
  writeFileSync(join(v, "concepts", "h.md"), createPageContent("Page H", []));

  // Orphan control page: no inlinks, no outlinks
  writeFileSync(join(v, "concepts", "orphan.md"), createPageContent("Page Orphan", []));

  return v;
}

function createControlVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-acyclic-control-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[g]]\n- [[h]]\n- [[orphan]]\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }

  // Acyclic control pages: g -> h, h has no outlinks, plus orphan
  writeFileSync(join(v, "concepts", "g.md"), createPageContent("Page G", ["h"]));
  writeFileSync(join(v, "concepts", "h.md"), createPageContent("Page H", []));
  writeFileSync(join(v, "concepts", "orphan.md"), createPageContent("Page Orphan", []));

  return v;
}

describe("cycle_traps rule", () => {
  it("emits exactly cycle members sorted and excludes acyclic/orphan control pages", async () => {
    const v = createFixtureVault();
    const scanRes = await scanVault(v);
    expect(scanRes.ok).toBe(true);
    if (!scanRes.ok) return;

    const ctx: LintRuleContext = {
      vault: v,
      scan: scanRes.data,
      pageTextCache: new Map(),
      days: 90,
      lines: 200,
      logThreshold: 500,
      wikilinkResolver: buildWikilinkResolver(scanRes.data.allMarkdown),
      cliSurface: buildCliSurface(),
    };

    const res = await cycleTrapsRule.run(ctx);
    expect(res.buckets.cycle_traps).toBeDefined();
    expect(res.buckets.cycle_traps).toEqual([
      "concepts/a.md",
      "concepts/b.md",
      "concepts/c.md",
      "concepts/d.md",
      "concepts/e.md",
      "concepts/f.md",
    ]);
  });

  it("produces zero cycle_traps items on acyclic control vault", async () => {
    const v = createControlVault();
    const scanRes = await scanVault(v);
    expect(scanRes.ok).toBe(true);
    if (!scanRes.ok) return;

    const ctx: LintRuleContext = {
      vault: v,
      scan: scanRes.data,
      pageTextCache: new Map(),
      days: 90,
      lines: 200,
      logThreshold: 500,
      wikilinkResolver: buildWikilinkResolver(scanRes.data.allMarkdown),
      cliSurface: buildCliSurface(),
    };

    const res = await cycleTrapsRule.run(ctx);
    expect(res.buckets.cycle_traps).toBeUndefined();
  });

  it("full runLint includes cycle_traps warning bucket", async () => {
    const v = createFixtureVault();
    const res = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(res.exitCode).toBe(22);
    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      const warningBucket = res.result.data.by_severity.warning.find((b) => b.kind === "cycle_traps");
      expect(warningBucket).toBeDefined();
      expect(warningBucket?.items).toEqual([
        "concepts/a.md",
        "concepts/b.md",
        "concepts/c.md",
        "concepts/d.md",
        "concepts/e.md",
        "concepts/f.md",
      ]);
    }
  });

  it("runLint with --only cycle_traps selects only cycle_traps bucket", async () => {
    const v = createFixtureVault();
    const res = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "cycle_traps" });
    expect(res.exitCode).toBe(22);
    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.data.by_severity.error).toEqual([]);
      expect(res.result.data.by_severity.info).toEqual([]);
      expect(res.result.data.by_severity.warning).toHaveLength(1);
      expect(res.result.data.by_severity.warning[0]?.kind).toBe("cycle_traps");
      expect(res.result.data.by_severity.warning[0]?.items).toEqual([
        "concepts/a.md",
        "concepts/b.md",
        "concepts/c.md",
        "concepts/d.md",
        "concepts/e.md",
        "concepts/f.md",
      ]);
    }
  });

  it("runLint with --only cycle_traps exits 0 on control vault", async () => {
    const v = createControlVault();
    const res = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "cycle_traps" });
    expect(res.exitCode).toBe(0);
    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.data.by_severity.warning).toEqual([]);
      expect(res.result.data.summary.warnings).toBe(0);
    }
  });
});
