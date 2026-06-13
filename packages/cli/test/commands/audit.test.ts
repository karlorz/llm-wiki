import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runAudit, validateCompoundReferences } from "../../src/commands/audit.js";

const F = (n: string) => join(__dirname, "..", "fixtures", "audit-vault", n);

describe("audit", () => {
  it("returns exit 0 for a clean page", async () => {
    const r = await runAudit({ file: F("concepts/clean.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.markers.every(m => m.resolved)).toBe(true);
      expect(r.result.data.sources_consistency.unused_sources).toEqual([]);
      expect(r.result.data.sources_consistency.missing_from_sources).toEqual([]);
    }
  });

  it("returns UNRESOLVED_MARKERS (11) for missing target", async () => {
    const r = await runAudit({ file: F("concepts/unresolved.md") });
    expect(r.exitCode).toBe(11);
  });

  it("resolves body citation markers against archived raw sources", async () => {
    const v = mkdtempSync(join(tmpdir(), "audit-vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Vault Schema\n");
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "_archive", "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "_archive", "raw", "articles", "archived.md"), "Archived source\n");
    writeFileSync(join(v, "concepts", "archived-marker.md"), `---
title: Archived marker
type: concept
tags: [model]
sources:
  - "^[raw/articles/archived.md]"
provenance: research
created: 2026-06-14
updated: 2026-06-14
---

## Overview

Archived claim. ^[raw/articles/archived.md]

## Sources

- ^[raw/articles/archived.md]
`);

    const r = await runAudit({ file: join(v, "concepts", "archived-marker.md") });

    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.markers.every(m => m.resolved)).toBe(true);
    }
  });

  it("returns SOURCES_INCONSISTENT (12) for unused sources", async () => {
    const r = await runAudit({ file: F("concepts/inconsistent.md") });
    expect(r.exitCode).toBe(12);
    if (r.result.ok) {
      expect(r.result.data.sources_consistency.unused_sources).toContain("raw/articles/y.md");
    }
  });

  it("returns exit 0 for new-style citation page with footer", async () => {
    const r = await runAudit({ file: F("concepts/newstyle.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.footer_consistency).toBeDefined();
      expect(r.result.data.footer_consistency!.missing_from_footer).toEqual([]);
      expect(r.result.data.footer_consistency!.extra_in_footer).toEqual([]);
    }
  });

  it("normalizes ^[...] format in sources frontmatter", async () => {
    // Sources frontmatter uses ^[raw/...] but markers extract raw/... paths
    // Audit should strip the ^[...] wrapper before comparing
    const r = await runAudit({ file: F("concepts/caret-sources.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.sources_consistency.unused_sources).toEqual([]);
      expect(r.result.data.sources_consistency.missing_from_sources).toEqual([]);
    }
  });
});

// --- Compound reference validation tests ---

const SCHEMA = "# Vault Schema\n";

function compoundVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n");
  writeFileSync(join(v, "log.md"), "# Log\n");
  mkdirSync(join(v, "raw"), { recursive: true });
  mkdirSync(join(v, "concepts"), { recursive: true });
  return v;
}

describe("validateCompoundReferences", () => {
  it("returns no findings for valid compound→work_item references", async () => {
    const v = compoundVault();
    mkdirSync(join(v, "projects", "myproj", "work", "2026-05-09-fix"), { recursive: true });
    mkdirSync(join(v, "projects", "myproj", "compound"), { recursive: true });
    writeFileSync(join(v, "projects", "myproj", "work", "2026-05-09-fix", "spec.md"),
      "---\ntitle: fix\nkind: feature\nstatus: completed\npriority: high\nproject: \"[[myproj]]\"\ncreated: 2026-05-09\nupdated: 2026-05-09\nstarted: 2026-05-09\n---\nBody\n");
    writeFileSync(join(v, "projects", "myproj", "compound", "lesson.md"),
      "---\ntitle: lesson\ntype: lesson\ntags: []\nconfidence: high\nproject: \"[[myproj]]\"\nwork_items: [\"[[projects/myproj/work/2026-05-09-fix/spec]]\"]\ncreated: 2026-05-09\nupdated: 2026-05-09\n---\nBody\n");
    const r = await validateCompoundReferences(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it("reports missing work_item", async () => {
    const v = compoundVault();
    mkdirSync(join(v, "projects", "myproj", "compound"), { recursive: true });
    writeFileSync(join(v, "projects", "myproj", "compound", "lesson.md"),
      "---\ntitle: lesson\ntype: lesson\ntags: []\nconfidence: high\nproject: \"[[myproj]]\"\nwork_items: [\"[[projects/myproj/work/2026-05-09-missing/spec]]\"]\ncreated: 2026-05-09\nupdated: 2026-05-09\n---\nBody\n");
    const r = await validateCompoundReferences(v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.kind).toBe("missing");
      expect(r.data[0]!.compound).toContain("lesson.md");
    }
  });

  it("reports cross-project work_item", async () => {
    const v = compoundVault();
    mkdirSync(join(v, "projects", "proj-a", "work", "2026-05-09-task"), { recursive: true });
    mkdirSync(join(v, "projects", "proj-b", "compound"), { recursive: true });
    writeFileSync(join(v, "projects", "proj-a", "work", "2026-05-09-task", "spec.md"),
      "---\ntitle: task\nkind: feature\nstatus: completed\npriority: high\nproject: \"[[proj-a]]\"\ncreated: 2026-05-09\nupdated: 2026-05-09\nstarted: 2026-05-09\n---\nBody\n");
    writeFileSync(join(v, "projects", "proj-b", "compound", "lesson.md"),
      "---\ntitle: lesson\ntype: lesson\ntags: []\nconfidence: high\nproject: \"[[proj-b]]\"\nwork_items: [\"[[projects/proj-a/work/2026-05-09-task/spec]]\"]\ncreated: 2026-05-09\nupdated: 2026-05-09\n---\nBody\n");
    const r = await validateCompoundReferences(v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.kind).toBe("cross_project");
    }
  });
});
