import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runQuery } from "../../src/commands/query.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

/** Create a minimal vault dir with SCHEMA.md; returns the vault root. */
function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "sw-query-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  return v;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("query", () => {
  it("returns ranked results for the sample vault", async () => {
    const r = await runQuery({ text: "alpha", vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeGreaterThan(0);
      // Alpha should be the top result — its title matches "alpha"
      const top = r.result.data.results[0];
      expect(top.path).toBe("concepts/alpha.md");
      expect(top.score).toBeGreaterThan(0);
      expect(top.title).toBe("Alpha");
      expect(top.type).toBe("concept");
    }
  });

  it("boosts pages connected via wikilink from seed pages", async () => {
    const r = await runQuery({ text: "alpha", vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // beta is linked from alpha — should appear due to wikilink boost
      const beta = r.result.data.results.find((p) => p.path === "concepts/beta.md");
      expect(beta).toBeDefined();
      expect(beta!.score).toBeGreaterThan(0);
    }
  });

  it("boosts pages sharing raw sources with seed pages", async () => {
    const r = await runQuery({ text: "alpha", vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // alpha has source raw/articles/x.md, beta also has raw/articles/x.md
      // beta should get a source overlap boost
      const beta = r.result.data.results.find((p) => p.path === "concepts/beta.md");
      expect(beta).toBeDefined();
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runQuery({ text: "test", vault: "/nope" });
    expect(r.exitCode).toBe(9);
  });

  it("returns empty results for empty vault", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    // Only SCHEMA.md, no typed-knowledge pages

    const r = await runQuery({ text: "anything", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results).toEqual([]);
      expect(r.result.data.humanHint).toBe("no matching pages found");
    }
  });

  it("returns empty results for empty query text", async () => {
    const r = await runQuery({ text: "", vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results).toEqual([]);
      expect(r.result.data.humanHint).toBe("no query terms");
    }
  });

  it("respects --limit option", async () => {
    const r = await runQuery({ text: "alpha", vault: VAULT, limit: 1 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeLessThanOrEqual(1);
    }
  });

  it("works with a vault that has graph.json pre-built", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "a.md"),
      "---\ntitle: Retrieval\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/x.md]\n---\nSee [[b]].\n",
    );
    writeFileSync(
      join(v, "concepts", "b.md"),
      "---\ntitle: Embeddings\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/x.md]\n---\nSee [[a]].\n",
    );

    // Pre-build graph
    mkdirSync(join(v, ".skillwiki"), { recursive: true });
    const { runGraphBuild } = await import("../../src/commands/graph.js");
    const graphResult = await runGraphBuild({
      vault: v,
      out: join(v, ".skillwiki", "graph.json"),
    });
    expect(graphResult.exitCode).toBe(0);

    const r = await runQuery({ text: "retrieval", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeGreaterThan(0);
      const top = r.result.data.results[0];
      expect(top.path).toBe("concepts/a.md");
    }
  });

  it("skips pages with invalid frontmatter without crashing", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "broken.md"),
      "---\ntitle: Broken\ntype: concept\nno closing delimiter\n",
    );
    writeFileSync(
      join(v, "concepts", "alpha.md"),
      "---\ntitle: Alpha\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nAlpha content.\n",
    );

    const r = await runQuery({ text: "alpha", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // broken.md skipped, alpha.md found
      expect(r.result.data.results.some((p) => p.path.includes("alpha"))).toBe(true);
      expect(r.result.data.results.some((p) => p.path.includes("broken"))).toBe(false);
    }
  });

  it("applies type affinity for conceptual queries", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "entities"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "pattern.md"),
      "---\ntitle: Pattern\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nA design pattern.\n",
    );
    writeFileSync(
      join(v, "entities", "pattern.md"),
      "---\ntitle: Pattern Inc\ntype: entity\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nA company named Pattern.\n",
    );

    // "what is pattern" has a conceptual indicator ("what")
    const r = await runQuery({ text: "what is pattern", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // Both should appear, but concept should score higher due to type affinity
      const concept = r.result.data.results.find((p) => p.path === "concepts/pattern.md");
      const entity = r.result.data.results.find((p) => p.path === "entities/pattern.md");
      expect(concept).toBeDefined();
      expect(entity).toBeDefined();
      expect(concept!.score).toBeGreaterThan(entity!.score);
    }
  });

  it("matches terms in tags", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "tagged.md"),
      "---\ntitle: TaggedPage\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: [retrieval, rag]\n---\nSome content.\n",
    );

    const r = await runQuery({ text: "retrieval", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeGreaterThan(0);
      expect(r.result.data.results[0].path).toBe("concepts/tagged.md");
    }
  });

  it("matches terms in body text", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "bodypage.md"),
      "---\ntitle: SomePage\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nThis page discusses vector databases and similarity search.\n",
    );

    const r = await runQuery({ text: "vector databases", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeGreaterThan(0);
      expect(r.result.data.results[0].path).toBe("concepts/bodypage.md");
    }
  });

  it("auto-builds graph when missing and uses it for scoring", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "x.md"),
      "---\ntitle: X Concept\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/s.md]\n---\nSee [[y]].\n",
    );
    writeFileSync(
      join(v, "concepts", "y.md"),
      "---\ntitle: Y Concept\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\nsources: [raw/articles/s.md]\n---\nSee [[x]].\n",
    );
    // No pre-built graph — query should trigger auto-build

    const r = await runQuery({ text: "x concept", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeGreaterThan(0);
      // Y should appear due to wikilink from X and shared sources
      const yResult = r.result.data.results.find((p) => p.path === "concepts/y.md");
      expect(yResult).toBeDefined();
    }
  });
});
