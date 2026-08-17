import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVectorIndex, loadVectorIndex, rankVectorIndex, vectorIndexStatus } from "../../src/utils/vector-index.js";

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
    expect((await vectorIndexStatus(root)).ok && (await vectorIndexStatus(root)).data?.present).toBe(false);
    const built = await buildVectorIndex(root, "2026-08-17T00:00:00.000Z");
    expect(built.ok).toBe(true);
    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(rankVectorIndex(loaded.data, "bananas")[0]).toBe("concepts/alpha.md");
    const status = await vectorIndexStatus(root);
    expect(status.ok && status.data?.present).toBe(true);
    expect(status.ok && status.data?.page_count).toBe(2);
  });

  it("reports missing cache as HYBRID_INDEX_MISSING", async () => {
    const root = vault();
    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBe("HYBRID_INDEX_MISSING");
  });
});
