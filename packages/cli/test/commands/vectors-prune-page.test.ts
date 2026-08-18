import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVectorIndex,
  loadVectorIndex,
  pruneVectorIndex,
  rankVectorIndex,
  vectorIndexPath,
} from "../../src/utils/vector-index.js";
import { runVectorsPrunePage } from "../../src/commands/vectors-prune-page.js";
import { ExitCode } from "@skillwiki/shared";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-tfidf-prune-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "concepts"), { recursive: true });
  writeFileSync(
    join(root, "concepts", "alpha.md"),
    "---\ntitle: Alpha\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nAlpha bananas uniquely bananas\n",
  );
  writeFileSync(
    join(root, "concepts", "beta.md"),
    "---\ntitle: Beta\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/x.md]\n---\nOranges and citrus fruit bananas\n",
  );
  writeFileSync(
    join(root, "concepts", "gamma.md"),
    "---\ntitle: Gamma Pattern\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: []\nsources: []\n---\nPattern matching with citrus fruit and oranges\n",
  );
  writeFileSync(
    join(root, "concepts", "delta.md"),
    "---\ntitle: Delta Engine\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: []\nsources: []\n---\nEngine bananas citrus database indexing\n",
  );
  return root;
}

describe("vector index - pruneVectorIndex", () => {
  it("fails closed with HYBRID_INDEX_MISSING when cache is missing", async () => {
    const root = vault();
    const res = await pruneVectorIndex(root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("HYBRID_INDEX_MISSING");
    }
  });

  it("performs no write when no orphans exist (index byte-stable)", async () => {
    const root = vault();
    await buildVectorIndex(root, "2026-08-17T10:00:00.000Z");

    const indexPath = vectorIndexPath(root);
    const beforeContent = readFileSync(indexPath, "utf8");
    const beforeStat = statSync(indexPath);

    const res = await pruneVectorIndex(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.orphans).toEqual([]);
    expect(res.data.removed).toBe(0);
    expect(res.data.terms_pruned).toBe(0);
    expect(res.data.page_count).toBe(4);

    const afterContent = readFileSync(indexPath, "utf8");
    const afterStat = statSync(indexPath);

    expect(afterContent).toBe(beforeContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("dry-run reports orphans without writing any changes to disk", async () => {
    const root = vault();
    await buildVectorIndex(root, "2026-08-17T10:00:00.000Z");

    // Delete alpha.md from filesystem to create an orphan
    unlinkSync(join(root, "concepts", "alpha.md"));

    const indexPath = vectorIndexPath(root);
    const beforeContent = readFileSync(indexPath, "utf8");
    const beforeStat = statSync(indexPath);

    const res = await pruneVectorIndex(root, { dryRun: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.orphans).toEqual(["concepts/alpha.md"]);
    expect(res.data.removed).toBe(1);
    expect(res.data.page_count).toBe(3);
    expect(res.data.terms_pruned).toBe(2); // 'alpha' and 'uniquely' were only in alpha.md

    const afterContent = readFileSync(indexPath, "utf8");
    const afterStat = statSync(indexPath);

    // Index file on disk must not have changed
    expect(afterContent).toBe(beforeContent);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("shared-term df is decremented while unique-term df is pruned", async () => {
    const root = vault();
    await buildVectorIndex(root);

    // Delete alpha.md
    // 'uniquely' is unique to alpha.md (df=1 -> df=0, should be pruned)
    // 'bananas' is shared with beta and delta (df=3 -> df=2, should be decremented not pruned)
    // 'alpha' is unique to alpha.md (df=1 -> df=0, should be pruned)
    unlinkSync(join(root, "concepts", "alpha.md"));

    const res = await pruneVectorIndex(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.orphans).toEqual(["concepts/alpha.md"]);
    expect(res.data.removed).toBe(1);
    expect(res.data.terms_pruned).toBeGreaterThan(0);

    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.data.docs["concepts/alpha.md"]).toBeUndefined();
    expect(loaded.data.df["uniquely"]).toBeUndefined();
    expect(loaded.data.df["alpha"]).toBeUndefined();
    expect(loaded.data.df["bananas"]).toBe(2);
    expect(loaded.data.page_count).toBe(3);
  });

  it("handles multiple orphans in a single pass", async () => {
    const root = vault();
    await buildVectorIndex(root);

    // Remove both alpha.md and gamma.md
    unlinkSync(join(root, "concepts", "alpha.md"));
    unlinkSync(join(root, "concepts", "gamma.md"));

    const res = await pruneVectorIndex(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.orphans.sort()).toEqual(["concepts/alpha.md", "concepts/gamma.md"]);
    expect(res.data.removed).toBe(2);
    expect(res.data.page_count).toBe(2);

    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.data.docs["concepts/alpha.md"]).toBeUndefined();
    expect(loaded.data.docs["concepts/gamma.md"]).toBeUndefined();
    expect(loaded.data.docs["concepts/beta.md"]).toBeDefined();
    expect(loaded.data.docs["concepts/delta.md"]).toBeDefined();
    expect(loaded.data.page_count).toBe(2);
  });

  it("golden equivalence: pruned index is identical to a full rebuild on the same fixture", async () => {
    const root = vault();
    await buildVectorIndex(root);

    // Delete alpha.md and gamma.md
    unlinkSync(join(root, "concepts", "alpha.md"));
    unlinkSync(join(root, "concepts", "gamma.md"));

    // Prune the index incrementally
    const pruneRes = await pruneVectorIndex(root);
    expect(pruneRes.ok).toBe(true);

    const prunedIndex = await loadVectorIndex(root);
    expect(prunedIndex.ok).toBe(true);
    if (!prunedIndex.ok) return;

    // Full rebuild on identical filesystem
    const fullRebuildRes = await buildVectorIndex(root);
    expect(fullRebuildRes.ok).toBe(true);
    if (!fullRebuildRes.ok) return;
    const fullIndex = fullRebuildRes.data;

    // 1. Compare df
    expect(prunedIndex.data.df).toEqual(fullIndex.df);

    // 2. Compare page_count
    expect(prunedIndex.data.page_count).toEqual(fullIndex.page_count);

    // 3. Compare docs keys
    expect(Object.keys(prunedIndex.data.docs).sort()).toEqual(Object.keys(fullIndex.docs).sort());

    // 4. Compare doc vectors (within float precision)
    for (const docKey of Object.keys(fullIndex.docs)) {
      const prunedDoc = prunedIndex.data.docs[docKey];
      const fullDoc = fullIndex.docs[docKey];
      expect(prunedDoc).toBeDefined();
      for (const term of Object.keys(fullDoc)) {
        expect(prunedDoc[term]).toBeCloseTo(fullDoc[term], 10);
      }
      for (const term of Object.keys(prunedDoc)) {
        expect(fullDoc[term]).toBeCloseTo(prunedDoc[term], 10);
      }
    }

    // 5. Compare ranking results across diverse queries
    const testQueries = [
      "citrus",
      "bananas",
      "database indexing",
      "delta engine oranges",
      "fruit pattern",
    ];
    for (const q of testQueries) {
      const prunedRanking = rankVectorIndex(prunedIndex.data, q);
      const fullRanking = rankVectorIndex(fullIndex, q);
      expect(prunedRanking).toEqual(fullRanking);
    }
  });

  it("handles complete vault emptying (all documents orphaned)", async () => {
    const root = vault();
    await buildVectorIndex(root);

    unlinkSync(join(root, "concepts", "alpha.md"));
    unlinkSync(join(root, "concepts", "beta.md"));
    unlinkSync(join(root, "concepts", "gamma.md"));
    unlinkSync(join(root, "concepts", "delta.md"));

    const res = await pruneVectorIndex(root);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.removed).toBe(4);
    expect(res.data.page_count).toBe(0);

    const loaded = await loadVectorIndex(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.data.page_count).toBe(0);
    expect(loaded.data.docs).toEqual({});
    expect(loaded.data.df).toEqual({});
  });
});

describe("runVectorsPrunePage command", () => {
  it("returns USAGE exit code when cache is missing", async () => {
    const root = vault();
    const res = await runVectorsPrunePage({ vault: root });
    expect(res.exitCode).toBe(ExitCode.USAGE);
    expect(res.result.ok).toBe(false);
  });

  it("returns OK with humanHint when no orphans exist", async () => {
    const root = vault();
    await buildVectorIndex(root);
    const res = await runVectorsPrunePage({ vault: root });
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    expect(res.result.data.removed).toBe(0);
    expect(res.result.data.orphans).toEqual([]);
    expect(res.result.data.page_count).toBe(4);
    expect(res.result.data.dry_run).toBe(false);
    expect(res.result.data.humanHint).toContain("no orphan pages");
  });

  it("returns OK with dry_run true and humanHint on dry-run", async () => {
    const root = vault();
    await buildVectorIndex(root);
    unlinkSync(join(root, "concepts", "alpha.md"));

    const res = await runVectorsPrunePage({ vault: root, dryRun: true });
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    expect(res.result.data.removed).toBe(1);
    expect(res.result.data.orphans).toEqual(["concepts/alpha.md"]);
    expect(res.result.data.page_count).toBe(3);
    expect(res.result.data.dry_run).toBe(true);
    expect(res.result.data.humanHint).toContain("dry run");
  });

  it("returns OK and removes orphans on execute", async () => {
    const root = vault();
    await buildVectorIndex(root);
    unlinkSync(join(root, "concepts", "alpha.md"));

    const res = await runVectorsPrunePage({ vault: root });
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;

    expect(res.result.data.removed).toBe(1);
    expect(res.result.data.orphans).toEqual(["concepts/alpha.md"]);
    expect(res.result.data.page_count).toBe(3);
    expect(res.result.data.dry_run).toBe(false);
    expect(res.result.data.humanHint).toContain("pruned 1 orphan page");
  });
});
