import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVault } from "../../src/utils/vault.js";
import { buildSourceReferenceIndex } from "../../src/utils/source-reference-index.js";

const dirs: string[] = [];

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-source-refs-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  mkdirSync(join(root, "concepts"), { recursive: true });
  mkdirSync(join(root, "projects", "demo", "work", "2026-08-02-test"), { recursive: true });
  writeFileSync(join(root, "raw", "articles", "one.md"), "---\nsource_url: https://example.com\ningested: 2026-08-02\n---\nOne\n");
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("source reference index", () => {
  it("deduplicates frontmatter and body citations per typed page", async () => {
    const root = vault();
    writeFileSync(join(root, "concepts", "a.md"), "---\ntitle: A\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources:\n  - raw/articles/one\n---\nClaim. ^[raw/articles/one.md]\n");
    writeFileSync(join(root, "concepts", "b.md"), "---\ntitle: B\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: []\n---\nClaim. ^[raw/articles/one.md]\n");
    writeFileSync(join(root, "projects", "demo", "work", "2026-08-02-test", "spec.md"), "Plain work reference. ^[raw/articles/one.md]\n");
    const scan = await scanVault(root);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const index = await buildSourceReferenceIndex({
      typedPages: scan.data.typedKnowledge,
      otherPages: scan.data.workItems,
      availableRawPaths: ["raw/articles/one.md"],
    });
    expect(index.integratedBy.get("raw/articles/one.md")).toEqual(["concepts/a.md", "concepts/b.md"]);
    expect(index.referencedElsewhereBy.get("raw/articles/one.md")).toEqual(["projects/demo/work/2026-08-02-test/spec.md"]);
    expect(index.unresolved).toEqual([]);
  });

  it("reports unresolved targets without hiding references", async () => {
    const root = vault();
    writeFileSync(join(root, "concepts", "missing.md"), "---\ntitle: Missing\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/missing.md]\n---\nBody\n");
    const scan = await scanVault(root);
    if (!scan.ok) throw new Error("scan failed");
    const index = await buildSourceReferenceIndex({ typedPages: scan.data.typedKnowledge, availableRawPaths: ["raw/articles/one.md"] });
    expect(index.integratedBy.get("raw/articles/missing.md")).toEqual(["concepts/missing.md"]);
    expect(index.unresolved).toEqual([{ sourcePath: "concepts/missing.md", target: "raw/articles/missing.md", kind: "typed" }]);
  });

  it("prefers a reused active raw path over historical relocation projection", async () => {
    const root = vault();
    mkdirSync(join(root, "raw", "archived", "articles"), { recursive: true });
    writeFileSync(join(root, "raw", "archived", "articles", "one.md"), "old archived bytes");
    writeFileSync(join(root, "concepts", "active.md"), "---\ntitle: Active\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/one]\n---\nClaim\n");
    const scan = await scanVault(root);
    if (!scan.ok) throw new Error("scan failed");
    const index = await buildSourceReferenceIndex({
      typedPages: scan.data.typedKnowledge,
      availableRawPaths: ["raw/articles/one.md", "raw/archived/articles/one.md"],
      relocationProjection: new Map([["raw/articles/one.md", "raw/archived/articles/one.md"]]),
    });
    expect(index.integratedBy.get("raw/articles/one.md")).toEqual(["concepts/active.md"]);
    expect(index.integratedBy.get("raw/archived/articles/one.md")).toBeUndefined();
  });
});
