import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVectorIndex, loadVectorIndex, pruneVectorIndex, rankVectorIndex, vectorIndexStatus } from "../../src/utils/vector-index.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-tfidf-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "concepts"), { recursive: true });
  writeFileSync(join(root, "concepts", "alpha.md"), "---\ntitle: Alpha\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nAlpha bananas uniquely bananas\n");
  writeFileSync(join(root, "concepts", "beta.md"), "---\ntitle: Beta\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nOranges and citrus fruit\n");
  return root;
}

describe("vector index", () => {
  it("builds a rebuildable cache and ranks overlapping terms first", async () => {
    const root = vault();
    const missing = await vectorIndexStatus(root);
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.data.present).toBe(false);
    const built = await buildVectorIndex(root, "2026-08-17T00:00:00.000Z");
    expect(built.ok).toBe(true);
    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(rankVectorIndex(loaded.data, "bananas")[0]).toBe("concepts/alpha.md");
    const status = await vectorIndexStatus(root);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.data.present).toBe(true);
    expect(status.data.page_count).toBe(2);
  });

  it("reports missing cache as HYBRID_INDEX_MISSING", async () => {
    const root = vault();
    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBe("HYBRID_INDEX_MISSING");
  });

  it("prunes orphans and matches full rebuild (golden equivalence)", async () => {
    const root = vault();
    await buildVectorIndex(root);
    rmSync(join(root, "concepts", "alpha.md"));
    const pruned = await pruneVectorIndex(root);
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) return;
    expect(pruned.data.orphans).toEqual(["concepts/alpha.md"]);
    expect(pruned.data.removed).toBe(1);

    const loadedPruned = await loadVectorIndex(root);
    expect(loadedPruned.ok).toBe(true);
    if (!loadedPruned.ok) return;

    const rebuilt = await buildVectorIndex(root);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    expect(loadedPruned.data.df).toEqual(rebuilt.data.df);
    expect(loadedPruned.data.page_count).toBe(rebuilt.data.page_count);
    expect(Object.keys(loadedPruned.data.docs).sort()).toEqual(Object.keys(rebuilt.data.docs).sort());
  });
});

