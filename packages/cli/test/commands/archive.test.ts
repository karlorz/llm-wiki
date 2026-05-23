import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runArchive } from "../../src/commands/archive.js";

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-05
updated: 2026-05-05
---

content`;

const RAW_FM = `---
source_url: https://example.com
ingested: "2026-05-07"
sha256: abc123
---

raw content`;

function makeVault(withIndex = false): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "concepts"), { recursive: true });
  if (withIndex) {
    writeFileSync(join(dir, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
  }
  return dir;
}

describe("runArchive", () => {
  it("archives a page and removes from index", async () => {
    const dir = makeVault(true);
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    const r = await runArchive({ vault: dir, page: "alpha" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.archived_from).toBe("concepts/alpha.md");
      expect(r.result.data.archived_to).toBe("_archive/concepts/alpha.md");
      expect(r.result.data.index_updated).toBe(true);
    }
    expect(existsSync(join(dir, "concepts", "alpha.md"))).toBe(false);
    expect(existsSync(join(dir, "_archive", "concepts", "alpha.md"))).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8")).not.toContain("[[alpha]]");
  });

  it("returns 30 for target not found", async () => {
    const dir = makeVault();
    const r = await runArchive({ vault: dir, page: "nonexistent" });
    expect(r.exitCode).toBe(30);
  });

  it("defines ARCHIVE_ALREADY_ARCHIVED as 31", () => {
    // ARCHIVE_ALREADY_ARCHIVED is a defensive check for pages that somehow
    // appear in scanVault results but start with _archive/. Cannot be easily
    // triggered in integration since scanVault skips _archive/.
    expect(ExitCode.ARCHIVE_ALREADY_ARCHIVED).toBe(31);
  });

  it("archives without index update when page not in index", async () => {
    const dir = makeVault(false);
    writeFileSync(join(dir, "concepts", "beta.md"), FM);
    const r = await runArchive({ vault: dir, page: "beta" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.index_updated).toBe(false);
    }
  });

  it("returns 9 for invalid vault", async () => {
    const r = await runArchive({ vault: "/nonexistent/path", page: "foo" });
    expect(r.exitCode).toBe(9);
  });

  it("archives a raw file to _archive/raw/ preserving subdirectory", async () => {
    const dir = makeVault(false);
    mkdirSync(join(dir, "raw", "articles"), { recursive: true });
    writeFileSync(join(dir, "raw", "articles", "foo.md"), RAW_FM);
    const r = await runArchive({ vault: dir, page: "raw/articles/foo.md" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.archived_from).toBe("raw/articles/foo.md");
      expect(r.result.data.archived_to).toBe("_archive/raw/articles/foo.md");
      expect(r.result.data.index_updated).toBe(false);
    }
    expect(existsSync(join(dir, "raw", "articles", "foo.md"))).toBe(false);
    expect(existsSync(join(dir, "_archive", "raw", "articles", "foo.md"))).toBe(true);
  });

  it("archives a raw file by filename only", async () => {
    const dir = makeVault(false);
    mkdirSync(join(dir, "raw", "articles"), { recursive: true });
    writeFileSync(join(dir, "raw", "articles", "bar.md"), RAW_FM);
    const r = await runArchive({ vault: dir, page: "bar" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.archived_from).toBe("raw/articles/bar.md");
      expect(r.result.data.archived_to).toBe("_archive/raw/articles/bar.md");
      expect(r.result.data.index_updated).toBe(false);
    }
    expect(existsSync(join(dir, "raw", "articles", "bar.md"))).toBe(false);
    expect(existsSync(join(dir, "_archive", "raw", "articles", "bar.md"))).toBe(true);
  });

  it("returns 30 for raw file not found", async () => {
    const dir = makeVault(false);
    mkdirSync(join(dir, "raw"), { recursive: true });
    const r = await runArchive({ vault: dir, page: "raw/articles/nope.md" });
    expect(r.exitCode).toBe(30);
  });

  it("prefers typed-knowledge over raw when slug matches both", async () => {
    const dir = makeVault(true);
    mkdirSync(join(dir, "raw", "articles"), { recursive: true });
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "raw", "articles", "alpha.md"), RAW_FM);
    const r = await runArchive({ vault: dir, page: "alpha" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.archived_from).toBe("concepts/alpha.md");
      expect(r.result.data.archived_to).toBe("_archive/concepts/alpha.md");
    }
    expect(existsSync(join(dir, "raw", "articles", "alpha.md"))).toBe(true);
  });

  // --- cascade tests ---

  it("--cascade preview reports wikilink + sources + index refs, no mutation", async () => {
    const dir = makeVault(true);
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    // Page that wikilinks to alpha
    writeFileSync(
      join(dir, "concepts", "bar.md"),
      `---\ntitle: bar\ntype: concept\ntags: []\nsources: []\nprovenance: research\ncreated: 2026-05-05\nupdated: 2026-05-05\n---\n\nReferences [[alpha]] twice and [[alpha|alias]].`,
    );
    // Page with alpha in sources array
    writeFileSync(
      join(dir, "concepts", "baz.md"),
      `---\ntitle: baz\ntype: concept\ntags: []\nsources:\n  - concepts/alpha.md\n  - raw/articles/other.md\nprovenance: research\ncreated: 2026-05-05\nupdated: 2026-05-05\n---\n\ncontent`,
    );
    const r = await runArchive({ vault: dir, page: "alpha", cascade: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.applied).toBe(false);
      expect(r.result.data.cascade).toBeDefined();
      expect(r.result.data.cascade!.wikilink_refs).toEqual([
        { page: "concepts/bar.md", count: 2 },
      ]);
      expect(r.result.data.cascade!.source_array_refs).toEqual([
        {
          page: "concepts/baz.md",
          sources_before: ["concepts/alpha.md", "raw/articles/other.md"],
          sources_after: ["raw/articles/other.md"],
        },
      ]);
      expect(r.result.data.cascade!.index_refs.length).toBeGreaterThan(0);
    }
    // No mutation: file still exists, baz still has alpha in sources
    expect(existsSync(join(dir, "concepts", "alpha.md"))).toBe(true);
    expect(existsSync(join(dir, "_archive", "concepts", "alpha.md"))).toBe(false);
    expect(readFileSync(join(dir, "concepts", "baz.md"), "utf8")).toContain("concepts/alpha.md");
    expect(readFileSync(join(dir, "index.md"), "utf8")).toContain("[[alpha]]");
  });

  it("--cascade --apply mutates sources arrays + archives", async () => {
    const dir = makeVault(true);
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(
      join(dir, "concepts", "baz.md"),
      `---\ntitle: baz\ntype: concept\ntags: []\nsources:\n  - concepts/alpha.md\n  - raw/articles/other.md\nprovenance: research\ncreated: 2026-05-05\nupdated: 2026-05-05\n---\n\ncontent`,
    );
    const r = await runArchive({ vault: dir, page: "alpha", cascade: true, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.applied).toBe(true);
    }
    // File archived
    expect(existsSync(join(dir, "concepts", "alpha.md"))).toBe(false);
    expect(existsSync(join(dir, "_archive", "concepts", "alpha.md"))).toBe(true);
    // baz sources cleaned (alpha removed; other.md preserved)
    const baz = readFileSync(join(dir, "concepts", "baz.md"), "utf8");
    expect(baz).not.toContain("concepts/alpha.md");
    expect(baz).toContain("raw/articles/other.md");
    // Index stripped
    expect(readFileSync(join(dir, "index.md"), "utf8")).not.toContain("[[alpha]]");
  });

  it("--cascade --apply preserves shared entities (sources entry removed, page kept)", async () => {
    const dir = makeVault(false);
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    // Page with ONLY alpha in sources — should still be kept (only entry removed)
    writeFileSync(
      join(dir, "concepts", "lonely.md"),
      `---\ntitle: lonely\ntype: concept\ntags: []\nsources:\n  - concepts/alpha.md\nprovenance: research\ncreated: 2026-05-05\nupdated: 2026-05-05\n---\n\ncontent`,
    );
    await runArchive({ vault: dir, page: "alpha", cascade: true, apply: true });
    // lonely.md must still exist
    expect(existsSync(join(dir, "concepts", "lonely.md"))).toBe(true);
    const lonely = readFileSync(join(dir, "concepts", "lonely.md"), "utf8");
    expect(lonely).not.toContain("concepts/alpha.md");
    // sources should be empty array (or empty list block) — alpha removed
    expect(lonely).toMatch(/sources:\s*(\[\]|\n)/);
  });

  it("plain archive (no --cascade) behaves as before — no cascade field in output", async () => {
    const dir = makeVault(true);
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    const r = await runArchive({ vault: dir, page: "alpha" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.cascade).toBeUndefined();
      expect(r.result.data.applied).toBeUndefined();
    }
  });
});
