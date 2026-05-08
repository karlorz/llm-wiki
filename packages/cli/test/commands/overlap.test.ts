import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runOverlap } from "../../src/commands/overlap.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

/** Create a minimal vault dir with SCHEMA.md; returns the vault root. */
function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "sw-overlap-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  return v;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("overlap", () => {
  it("clusters pages that share raw sources", async () => {
    const r = await runOverlap({ vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // alpha + beta share x; beta + gamma share y → all three connected
      const big = r.result.data.clusters.find(c => c.members.length >= 2);
      expect(big).toBeDefined();
      expect(big!.score).toBeGreaterThan(0);
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runOverlap({ vault: "/nope" });
    expect(r.exitCode).toBe(9);
  });

  it("handles vault with no overlapping sources", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(join(v, "concepts", "alpha.md"),
      "---\ntitle: Alpha\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/a.md]\n---\nPage A.\n");
    writeFileSync(join(v, "concepts", "beta.md"),
      "---\ntitle: Beta\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/b.md]\n---\nPage B.\n");

    const r = await runOverlap({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.clusters).toEqual([]);
    }
  });

  it("handles empty vault", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    // Only SCHEMA.md, no typed-knowledge dirs or pages

    const r = await runOverlap({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.clusters).toEqual([]);
    }
  });

  it("forms separate clusters for non-overlapping groups", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // Cluster 1: A and B share source x
    writeFileSync(join(v, "concepts", "a.md"),
      "---\ntitle: A\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/x.md]\n---\nPage A.\n");
    writeFileSync(join(v, "concepts", "b.md"),
      "---\ntitle: B\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/x.md]\n---\nPage B.\n");
    // Cluster 2: C and D share source y (no overlap with cluster 1)
    writeFileSync(join(v, "concepts", "c.md"),
      "---\ntitle: C\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/y.md]\n---\nPage C.\n");
    writeFileSync(join(v, "concepts", "d.md"),
      "---\ntitle: D\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/y.md]\n---\nPage D.\n");

    const r = await runOverlap({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.clusters).toHaveLength(2);
      for (const cluster of r.result.data.clusters) {
        expect(cluster.members).toHaveLength(2);
        expect(cluster.score).toBeGreaterThan(0);
      }
    }
  });

  it("skips pages with invalid frontmatter without crashing", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // Page with unclosed frontmatter — extractFrontmatter returns !ok
    writeFileSync(join(v, "concepts", "broken.md"),
      "---\ntitle: Broken\ntype: concept\nno closing delimiter\n");
    // A valid page that would form a cluster with another valid page
    writeFileSync(join(v, "concepts", "alpha.md"),
      "---\ntitle: Alpha\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/z.md]\n---\nPage Alpha.\n");
    writeFileSync(join(v, "concepts", "beta.md"),
      "---\ntitle: Beta\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/z.md]\n---\nPage Beta.\n");

    const r = await runOverlap({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // Only alpha + beta should form a cluster; broken page is skipped
      expect(r.result.data.clusters).toHaveLength(1);
      const cluster = r.result.data.clusters[0];
      expect(cluster.members).toHaveLength(2);
      expect(cluster.members.some(m => m.includes("broken"))).toBe(false);
    }
  });

  it("handles pages with no sources field (undefined → empty set)", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // Pages without a sources field — the ?? [] fallback produces empty sets
    writeFileSync(join(v, "concepts", "nosrc1.md"),
      "---\ntitle: NoSrc1\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nNo sources here.\n");
    writeFileSync(join(v, "concepts", "nosrc2.md"),
      "---\ntitle: NoSrc2\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nAlso no sources.\n");

    const r = await runOverlap({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.clusters).toEqual([]);
      expect(r.result.data.humanHint).toBe("no overlap clusters found");
    }
  });

  it("detects transitive overlap", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // A shares source x with B; B shares source y with C; A and C share nothing directly
    writeFileSync(join(v, "concepts", "a.md"),
      "---\ntitle: A\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/x.md]\n---\nPage A.\n");
    writeFileSync(join(v, "concepts", "b.md"),
      "---\ntitle: B\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/x.md, raw/articles/y.md]\n---\nPage B.\n");
    writeFileSync(join(v, "concepts", "c.md"),
      "---\ntitle: C\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/y.md]\n---\nPage C.\n");

    const r = await runOverlap({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // Union-find should merge all three into a single cluster
      expect(r.result.data.clusters).toHaveLength(1);
      const cluster = r.result.data.clusters[0];
      expect(cluster.members).toHaveLength(3);
      expect(cluster.score).toBeGreaterThan(0);
      const memberSet = new Set(cluster.members);
      expect(memberSet.has("concepts/a.md")).toBe(true);
      expect(memberSet.has("concepts/b.md")).toBe(true);
      expect(memberSet.has("concepts/c.md")).toBe(true);
    }
  });
});
