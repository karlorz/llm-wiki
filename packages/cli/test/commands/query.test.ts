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

  it("boosts entity type for non-conceptual queries", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "entities"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "alpha.md"),
      "---\ntitle: Alpha\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nAlpha content.\n",
    );
    writeFileSync(
      join(v, "entities", "alpha.md"),
      "---\ntitle: Alpha\ntype: entity\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nAlpha entity content.\n",
    );
    // Non-conceptual query: no concept indicators → entity gets 0.5 affinity boost
    const r = await runQuery({ text: "alpha", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // Both should appear since both match "alpha" but entity gets type affinity
      const concept = r.result.data.results.find((p) => p.path === "concepts/alpha.md");
      const entity = r.result.data.results.find((p) => p.path === "entities/alpha.md");
      expect(concept).toBeDefined();
      expect(entity).toBeDefined();
      // Entity should have a higher score due to type affinity for non-concept query
      expect(entity!.score).toBeGreaterThan(concept!.score);
    }
  });

  it("produces humanHint listing each result with score", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "searchable.md"),
      "---\ntitle: Searchable\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nContent about searchable things.\n",
    );

    const r = await runQuery({ text: "searchable", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("concepts/searchable.md");
      expect(r.result.data.humanHint).toContain("score:");
    }
  });

  it("scores title match higher than body match", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "zing.md"),
      "---\ntitle: Zing\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nGeneric body.\n",
    );
    writeFileSync(
      join(v, "concepts", "other.md"),
      "---\ntitle: Other\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nZing is mentioned in the body.\n",
    );

    const r = await runQuery({ text: "zing", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      const zing = r.result.data.results.find((p) => p.path === "concepts/zing.md");
      const other = r.result.data.results.find((p) => p.path === "concepts/other.md");
      expect(zing).toBeDefined();
      expect(other).toBeDefined();
      expect(zing!.score).toBeGreaterThan(other!.score);
    }
  });

  it("multi-term query matches pages containing all terms with higher score", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(
      join(v, "concepts", "both.md"),
      "---\ntitle: Vector Search\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: [retrieval]\n---\nVector search combines embeddings and retrieval.\n",
    );
    writeFileSync(
      join(v, "concepts", "partial.md"),
      "---\ntitle: Embeddings Only\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nJust vector content.\n",
    );

    const r = await runQuery({ text: "vector search", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      const both = r.result.data.results.find((p) => p.path === "concepts/both.md");
      const partial = r.result.data.results.find((p) => p.path === "concepts/partial.md");
      expect(both).toBeDefined();
      if (partial) {
        expect(both!.score).toBeGreaterThan(partial.score);
      }
    }
  });

  it("uses default limit of 10 when not specified", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // Create more than 10 pages all matching "test"
    for (let i = 0; i < 12; i++) {
      writeFileSync(
        join(v, "concepts", `test-${i}.md`),
        `---\ntitle: Test ${i}\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nTest content ${i}.\n`,
      );
    }

    const r = await runQuery({ text: "test", vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.results.length).toBeLessThanOrEqual(10);
    }
  });

  it("returns pending evidence separately without changing typed results", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "concepts", "typed.md"), "---\ntitle: Codex Typed\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/other.md]\n---\nCodex typed knowledge.\n");
    writeFileSync(join(v, "raw", "articles", "2026-08-02-pending.md"), "---\ntitle: Codex Pending\nsource_url: https://example.com/pending\ningested: 2026-08-02\ningested_by: manual\n---\nPending evidence.\n");

    const normal = await runQuery({ text: "Codex", vault: v });
    const included = await runQuery({ text: "Codex", vault: v, includePending: true });
    expect(normal.result.ok && normal.result.data.results).toEqual(included.result.ok && included.result.data.results);
    expect(normal.result.ok && normal.result.data.pending_sources).toBeUndefined();
    expect(included.result.ok && included.result.data.pending_sources?.map((item) => item.raw_path)).toEqual(["raw/articles/2026-08-02-pending.md"]);
  });

  it("discounts repetitive historical maintenance-cycle pages when an operational seed exists", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "queries"), { recursive: true });
    const fm = (title: string, type: string) =>
      `---\ntitle: ${title}\ntype: ${type}\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/ops.md]\n---\nS3 push operational evidence.\n`;
    writeFileSync(join(v, "concepts", "s3-push.md"), fm("S3 Push", "concept"));
    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(
        join(v, "queries", `2026-07-0${i}-daily-maintenance-research-cycle-${i}.md`),
        fm(`Daily maintenance research cycle ${i}`, "query"),
      );
    }

    const r = await runQuery({ text: "S3 push", vault: v, limit: 4 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.ranking_guardrails).toMatchObject({
        repetitive_historical_cycles_suppressed: true,
        historical_cycle_page_count: 3,
      });
      expect(r.result.data.results[0]?.path).toBe("concepts/s3-push.md");

      const repeat = await runQuery({ text: "S3 push", vault: v, limit: 4 });
      expect(repeat.result.ok).toBe(true);
      if (repeat.result.ok) expect(repeat.result.data.results).toEqual(r.result.data.results);
    }
  });

  it("does not suppress historical cycles when fewer than three are present", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "queries"), { recursive: true });
    const fm = (title: string, type: string) =>
      `---\ntitle: ${title}\ntype: ${type}\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/ops.md]\n---\nS3 push operational evidence.\n`;
    writeFileSync(join(v, "concepts", "s3-push.md"), fm("S3 Push", "concept"));
    for (let i = 1; i <= 2; i += 1) {
      writeFileSync(
        join(v, "queries", `2026-07-0${i}-daily-maintenance-research-cycle-${i}.md`),
        fm(`Daily maintenance research cycle ${i}`, "query"),
      );
    }
    const r = await runQuery({ text: "S3 push", vault: v });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) expect(r.result.data.ranking_guardrails).toBeUndefined();
  });

  it("does not suppress cycles when no direct operational seed exists", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "queries"), { recursive: true });
    const fm = (title: string) =>
      `---\ntitle: ${title}\ntype: query\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/ops.md]\n---\nS3 push historical evidence.\n`;
    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(
        join(v, "queries", `2026-07-0${i}-daily-maintenance-research-cycle-${i}.md`),
        fm(`Daily maintenance research cycle ${i}`),
      );
    }
    const r = await runQuery({ text: "S3 push", vault: v });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.ranking_guardrails).toBeUndefined();
      expect(r.result.data.results.every((item) => item.path.startsWith("queries/"))).toBe(true);
    }
  });

  it("does not classify daily maintenance notes as historical cycles", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    mkdirSync(join(v, "queries"), { recursive: true });
    const fm = (title: string, type: string) =>
      `---\ntitle: ${title}\ntype: ${type}\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/ops.md]\n---\nS3 push operational evidence.\n`;
    writeFileSync(join(v, "concepts", "s3-push.md"), fm("S3 Push", "concept"));
    for (let i = 1; i <= 3; i += 1) {
      writeFileSync(join(v, "queries", `daily-maintenance-notes-${i}.md`), fm(`Daily maintenance notes ${i}`, "query"));
    }
    const r = await runQuery({ text: "S3 push", vault: v });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) expect(r.result.data.ranking_guardrails).toBeUndefined();
  });
});
