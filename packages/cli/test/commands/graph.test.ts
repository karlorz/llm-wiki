import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runGraphBuild } from "../../src/commands/graph.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

/** Create a minimal vault dir with SCHEMA.md; returns the vault root. */
function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "sw-graph-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  return v;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("graph build", () => {
  it("computes adjacency for the sample vault", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "sw-graph-"));
    tmpDirs.push(outDir);
    const out = join(outDir, "graph.json");
    const r = await runGraphBuild({ vault: VAULT, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(3);
      expect(r.result.data.edge_count).toBeGreaterThan(0);
      expect(r.result.data.out_path).toBe(out);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.adjacency["concepts/alpha.md"]).toContain("concepts/beta.md");
      expect(data.adamicAdar).toBeDefined();
    }
  });

  it("returns VAULT_PATH_INVALID for bad path", async () => {
    const r = await runGraphBuild({ vault: "/no/path", out: "/tmp/g.json" });
    expect(r.exitCode).toBe(9);
  });

  it("handles vault with no wikilinks", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(join(v, "concepts", "solo.md"),
      "---\ntitle: Solo\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nNo links here.\n");
    writeFileSync(join(v, "concepts", "another.md"),
      "---\ntitle: Another\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nAlso no links.\n");

    const out = join(v, "graph.json");
    const r = await runGraphBuild({ vault: v, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(2);
      expect(r.result.data.edge_count).toBe(0);
      const data = JSON.parse(readFileSync(out, "utf8"));
      // adjacency has keys for each page but empty arrays
      expect(Object.keys(data.adjacency)).toHaveLength(2);
      for (const neighbors of Object.values(data.adjacency) as string[][]) {
        expect(neighbors).toEqual([]);
      }
    }
  });

  it("handles empty vault", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    // Only SCHEMA.md, no typed-knowledge dirs at all

    const out = join(v, "graph.json");
    const r = await runGraphBuild({ vault: v, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(0);
      expect(r.result.data.edge_count).toBe(0);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.adjacency).toEqual({});
    }
  });

  it("includes adamic-adar scores", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // a -> b, c;  b -> a;  c -> a   — all share a as common neighbor
    writeFileSync(join(v, "concepts", "a.md"),
      "---\ntitle: A\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nSee [[b]] and [[c]].\n");
    writeFileSync(join(v, "concepts", "b.md"),
      "---\ntitle: B\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nSee [[a]].\n");
    writeFileSync(join(v, "concepts", "c.md"),
      "---\ntitle: C\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nSee [[a]].\n");

    const out = join(v, "graph.json");
    const r = await runGraphBuild({ vault: v, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.adamicAdar).toBeDefined();
      // b and c share neighbor a, so adamicAdar[b][c] should be a positive number
      const aa = data.adamicAdar as Record<string, Record<string, number>>;
      const bKey = "concepts/b.md";
      const cKey = "concepts/c.md";
      expect(aa[bKey]).toBeDefined();
      expect(aa[bKey][cKey]).toBeTypeOf("number");
      expect(aa[bKey][cKey]).toBeGreaterThan(0);
    }
  });

  it("filters out wikilinks to non-existent pages", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(join(v, "concepts", "alpha.md"),
      "---\ntitle: Alpha\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nSee [[ghost]].\n");

    const out = join(v, "graph.json");
    const r = await runGraphBuild({ vault: v, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(1);
      expect(r.result.data.edge_count).toBe(0);
      const data = JSON.parse(readFileSync(out, "utf8"));
      expect(data.adjacency["concepts/alpha.md"]).toEqual([]);
    }
  });

  it("returns WRITE_FAILED when output path is not writable", async () => {
    // Use a valid vault but an output path inside a read-only directory
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // Point output at a path whose parent cannot be created — use /proc/nonexistent/g.json on macOS
    // Actually, use a path where the parent dir is a file, not a directory
    const blockFile = join(v, "blocker");
    writeFileSync(blockFile, "not a dir");
    const out = join(blockFile, "graph.json");
    const r = await runGraphBuild({ vault: v, out });
    expect(r.exitCode).toBe(10); // WRITE_FAILED
    expect(r.result.ok).toBe(false);
  });

  it("handles page with malformed frontmatter by using full text as body", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    // No closing ---, so splitFrontmatter fails and the full text is used as body
    writeFileSync(join(v, "concepts", "bad.md"),
      "---\ntitle: Bad\ntype: concept\nNo closing delimiter.\nSee [[other]].\n");

    const out = join(v, "graph.json");
    const r = await runGraphBuild({ vault: v, out });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.node_count).toBe(1);
      // The wikilink [[other]] should still be parsed from the full text fallback
      const data = JSON.parse(readFileSync(out, "utf8"));
      // "other" doesn't exist as a page, so the adjacency list is empty
      expect(data.adjacency["concepts/bad.md"]).toEqual([]);
    }
  });

  it("defaults --out to <vault>/.skillwiki/graph.json, not CWD-relative", async () => {
    const v = makeVault();
    tmpDirs.push(v);
    mkdirSync(join(v, "concepts"), { recursive: true });
    writeFileSync(join(v, "concepts", "solo.md"),
      "---\ntitle: Solo\ntype: concept\ncreated: 2026-05-09\nupdated: 2026-05-09\ntags: []\n---\nNo links.\n");

    const cli = join(__dirname, "..", "..", "dist", "cli.js");
    const expectedOut = join(v, ".skillwiki", "graph.json");

    // Run from a different CWD to prove --out resolves against vault, not CWD
    execFileSync("node", [cli, "graph", "build", v], { cwd: tmpdir() });

    // Graph should exist inside the vault, not in the CWD
    expect(existsSync(expectedOut)).toBe(true);
    const data = JSON.parse(readFileSync(expectedOut, "utf8"));
    expect(data.adjacency).toBeDefined();
  });
});
