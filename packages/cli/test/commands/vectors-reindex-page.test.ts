import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVectorIndex, loadVectorIndex, rankVectorIndex, reindexPageInVectorIndex } from "../../src/utils/vector-index.js";
import { runVectorsReindexPage } from "../../src/commands/vectors-reindex-page.js";
import { ExitCode } from "@skillwiki/shared";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-tfidf-reindex-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "concepts"), { recursive: true });
  writeFileSync(
    join(root, "concepts", "alpha.md"),
    "---\ntitle: Alpha\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nAlpha bananas uniquely bananas\n",
  );
  writeFileSync(
    join(root, "concepts", "beta.md"),
    "---\ntitle: Beta\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nOranges and citrus fruit\n",
  );
  return root;
}

describe("vector index - reindexPageInVectorIndex", () => {
  it("fails closed with HYBRID_INDEX_MISSING when cache is missing", async () => {
    const root = vault();
    const res = await reindexPageInVectorIndex(root, "concepts/alpha.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("HYBRID_INDEX_MISSING");
    }
  });

  it("returns FILE_NOT_FOUND when the target page file does not exist", async () => {
    const root = vault();
    await buildVectorIndex(root);
    const res = await reindexPageInVectorIndex(root, "concepts/nonexistent.md");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("FILE_NOT_FOUND");
    }
  });

  it("returns USAGE when target page is not a .md file", async () => {
    const root = vault();
    await buildVectorIndex(root);
    const res = await reindexPageInVectorIndex(root, "concepts/alpha.txt");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("USAGE");
    }
  });

  it("increments page_count when reindexing a newly created page", async () => {
    const root = vault();
    await buildVectorIndex(root);
    // Add gamma.md
    writeFileSync(
      join(root, "concepts", "gamma.md"),
      "---\ntitle: Gamma\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: []\n---\nGamma apples and bananas\n",
    );
    const res = await reindexPageInVectorIndex(root, "concepts/gamma.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.page_count).toBe(3);
    expect(res.data.terms_added).toBeGreaterThan(0);
    expect(res.data.terms_removed).toBe(0);

    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.page_count).toBe(3);
    expect(loaded.data.docs["concepts/gamma.md"]).toBeDefined();
  });

  it("prunes zero-count df terms when terms are removed", async () => {
    const root = vault();
    await buildVectorIndex(root);
    // Replace alpha content removing 'uniquely' and 'bananas'
    writeFileSync(
      join(root, "concepts", "alpha.md"),
      "---\ntitle: Alpha\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nAlpha strawberries only\n",
    );
    const res = await reindexPageInVectorIndex(root, "concepts/alpha.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.terms_removed).toBeGreaterThan(0);

    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.df["uniquely"]).toBeUndefined();
    expect(loaded.data.df["bananas"]).toBeUndefined();
    expect(loaded.data.df["strawberries"]).toBe(1);
  });

  it("normalizes backslashes to forward slashes in page keys", async () => {
    const root = vault();
    await buildVectorIndex(root);
    const res = await reindexPageInVectorIndex(root, "concepts\\alpha.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.page).toBe("concepts/alpha.md");

    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.data.docs["concepts/alpha.md"]).toBeDefined();
    expect(loaded.data.docs["concepts\\alpha.md"]).toBeUndefined();
  });

  it("golden equivalence: incremental reindex produces rankings and df identical to a full rebuild", async () => {
    const root = vault();
    // Add extra pages for richer corpus
    writeFileSync(
      join(root, "concepts", "gamma.md"),
      "---\ntitle: Gamma Pattern\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: []\nsources: []\n---\nPattern matching with citrus fruit and oranges\n",
    );
    writeFileSync(
      join(root, "concepts", "delta.md"),
      "---\ntitle: Delta Engine\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: []\nsources: []\n---\nEngine bananas citrus database indexing\n",
    );

    // Initial build
    await buildVectorIndex(root);

    // Modify beta.md: change content and add new shared/unique terms
    writeFileSync(
      join(root, "concepts", "beta.md"),
      "---\ntitle: Beta Citrus Machine\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [citrus]\nsources: []\n---\nMachine oranges and database indexing bananas\n",
    );

    // Incremental reindex
    const reindexRes = await reindexPageInVectorIndex(root, "concepts/beta.md");
    expect(reindexRes.ok).toBe(true);

    const incrementalIndex = await loadVectorIndex(root);
    expect(incrementalIndex.ok).toBe(true);
    if (!incrementalIndex.ok) return;

    // Full rebuild on identical filesystem
    const fullRebuildRes = await buildVectorIndex(root);
    expect(fullRebuildRes.ok).toBe(true);
    if (!fullRebuildRes.ok) return;
    const fullIndex = fullRebuildRes.data;

    // Compare df
    expect(incrementalIndex.data.df).toEqual(fullIndex.df);
    // Compare page_count
    expect(incrementalIndex.data.page_count).toEqual(fullIndex.page_count);
    // Compare docs keys
    expect(Object.keys(incrementalIndex.data.docs).sort()).toEqual(Object.keys(fullIndex.docs).sort());

    // Compare doc vectors (within float precision or exact)
    for (const docKey of Object.keys(fullIndex.docs)) {
      const incDoc = incrementalIndex.data.docs[docKey];
      const fullDoc = fullIndex.docs[docKey];
      expect(incDoc).toBeDefined();
      for (const term of Object.keys(fullDoc)) {
        expect(incDoc[term]).toBeCloseTo(fullDoc[term], 10);
      }
      for (const term of Object.keys(incDoc)) {
        expect(fullDoc[term]).toBeCloseTo(incDoc[term], 10);
      }
    }

    // Compare ranking results for several queries
    const testQueries = ["citrus", "bananas", "database indexing", "alpha bananas", "machine oranges pattern", "fruit"];
    for (const q of testQueries) {
      const incRanking = rankVectorIndex(incrementalIndex.data, q);
      const fullRanking = rankVectorIndex(fullIndex, q);
      expect(incRanking).toEqual(fullRanking);
    }
  });

  describe("runVectorsReindexPage command", () => {
    it("returns FILE_NOT_FOUND exit code when page does not exist", async () => {
      const root = vault();
      await buildVectorIndex(root);
      const res = await runVectorsReindexPage({ vault: root, page: "concepts/nonexistent.md" });
      expect(res.exitCode).toBe(ExitCode.FILE_NOT_FOUND);
      expect(res.result.ok).toBe(false);
    });

    it("returns USAGE exit code when cache is missing", async () => {
      const root = vault();
      const res = await runVectorsReindexPage({ vault: root, page: "concepts/alpha.md" });
      expect(res.exitCode).toBe(ExitCode.USAGE);
      expect(res.result.ok).toBe(false);
    });

    it("returns OK with humanHint and output data on success", async () => {
      const root = vault();
      await buildVectorIndex(root);
      const res = await runVectorsReindexPage({ vault: root, page: "concepts/alpha.md" });
      expect(res.exitCode).toBe(ExitCode.OK);
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) return;
      expect(res.result.data.page).toBe("concepts/alpha.md");
      expect(res.result.data.page_count).toBe(2);
      expect(res.result.data.humanHint).toContain("reindexed concepts/alpha.md");
    });
  });
});
