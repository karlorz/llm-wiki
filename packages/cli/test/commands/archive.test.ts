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
});
