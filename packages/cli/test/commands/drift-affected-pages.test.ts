import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrift } from "../../src/commands/drift.js";
import { ok } from "@skillwiki/shared";

const dirs: string[] = [];

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-drift-affected-"));
  dirs.push(dir);
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "articles"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  mkdirSync(join(dir, "entities"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const STORED_HASH = "a".repeat(64);
const RAW_FM_TEMPLATE = (url: string, hash: string) => `---
sha256: ${hash}
source_url: ${url}
ingested: "2026-05-05"
ingested_by: wiki-ingest
---

body content here`;

describe("runDrift --affected-pages", () => {
  it("drifted raw with one citing page lists the page in affected_pages", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
    writeFileSync(
      join(dir, "concepts", "concept-a.md"),
      `---\ntitle: Concept A\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nSome concept body.\n`,
    );

    const r = await runDrift({
      vault: dir,
      affectedPages: true,
      fetchFn: async () => ok({ body: "changed content here" }),
    });

    expect(r.exitCode).toBe(32);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.drifted.length).toBe(1);
      expect(r.result.data.drifted[0].raw_path).toBe("raw/articles/src.md");
      expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/concept-a.md"]);
      expect(r.result.data.humanHint).toContain("raw/articles/src.md");
      expect(r.result.data.humanHint).toContain("  affected: concepts/concept-a.md");
    }
  });

  it("drifted raw with two citing pages lists both in deterministic sorted order", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
    writeFileSync(
      join(dir, "concepts", "zebra.md"),
      `---\ntitle: Zebra\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nZebra concept.\n`,
    );
    writeFileSync(
      join(dir, "entities", "alpha.md"),
      `---\ntitle: Alpha\ntype: entity\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nAlpha entity.\n`,
    );

    const r = await runDrift({
      vault: dir,
      affectedPages: true,
      fetchFn: async () => ok({ body: "changed content here" }),
    });

    expect(r.exitCode).toBe(32);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.drifted.length).toBe(1);
      expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/zebra.md", "entities/alpha.md"].sort());
      expect(r.result.data.humanHint).toContain("raw/articles/src.md");
      expect(r.result.data.humanHint).toContain("  affected: concepts/zebra.md");
      expect(r.result.data.humanHint).toContain("  affected: entities/alpha.md");
    }
  });

  it("drifted raw with zero citations returns empty array for affected_pages", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));

    const r = await runDrift({
      vault: dir,
      affectedPages: true,
      fetchFn: async () => ok({ body: "changed content here" }),
    });

    expect(r.exitCode).toBe(32);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.drifted.length).toBe(1);
      expect(r.result.data.drifted[0].affected_pages).toEqual([]);
      expect(r.result.data.humanHint).toBe(
        "scanned: 1, unchanged: 0\ndrifted: 1\n  raw/articles/src.md",
      );
    }
  });

  it("no drift is a no-op with identical shape to plain drift", async () => {
    const dir = makeVault();
    const matchingHash = "d8c281f1829771acffd8bf707720f0aed9f0c22c9c4aac2f34e06413044a0043";
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", matchingHash));
    writeFileSync(
      join(dir, "concepts", "concept-a.md"),
      `---\ntitle: Concept A\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nSome concept body.\n`,
    );

    const rWithoutFlag = await runDrift({
      vault: dir,
      fetchFn: async () => ok({ body: "body content here" }),
    });

    const rWithFlag = await runDrift({
      vault: dir,
      affectedPages: true,
      fetchFn: async () => ok({ body: "body content here" }),
    });

    expect(rWithFlag.exitCode).toBe(0);
    expect(rWithFlag.result).toEqual(rWithoutFlag.result);
  });

  describe("citation forms coverage", () => {
    it("indexes body ^[raw/...] markers with .md extension", async () => {
      const dir = makeVault();
      writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
      writeFileSync(
        join(dir, "concepts", "body-marker.md"),
        `---\ntitle: Body Marker\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources: []\n---\n\nClaim here. ^[raw/articles/src.md]\n`,
      );

      const r = await runDrift({
        vault: dir,
        affectedPages: true,
        fetchFn: async () => ok({ body: "changed content here" }),
      });

      expect(r.exitCode).toBe(32);
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/body-marker.md"]);
      }
    });

    it("indexes body ^[raw/...] markers without .md extension", async () => {
      const dir = makeVault();
      writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
      writeFileSync(
        join(dir, "concepts", "body-marker-noext.md"),
        `---\ntitle: Body Marker No Ext\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources: []\n---\n\nClaim here. ^[raw/articles/src]\n`,
      );

      const r = await runDrift({
        vault: dir,
        affectedPages: true,
        fetchFn: async () => ok({ body: "changed content here" }),
      });

      expect(r.exitCode).toBe(32);
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/body-marker-noext.md"]);
      }
    });

    it("indexes sources: frontmatter list items with and without .md extension", async () => {
      const dir = makeVault();
      writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
      writeFileSync(
        join(dir, "concepts", "fm-ext.md"),
        `---\ntitle: FM Ext\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nBody.\n`,
      );
      writeFileSync(
        join(dir, "concepts", "fm-noext.md"),
        `---\ntitle: FM No Ext\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src\n---\n\nBody.\n`,
      );

      const r = await runDrift({
        vault: dir,
        affectedPages: true,
        fetchFn: async () => ok({ body: "changed content here" }),
      });

      expect(r.exitCode).toBe(32);
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/fm-ext.md", "concepts/fm-noext.md"]);
      }
    });

    it("deduplicates when a page has both frontmatter and body citations to the same source", async () => {
      const dir = makeVault();
      writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
      writeFileSync(
        join(dir, "concepts", "both.md"),
        `---\ntitle: Both\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nClaim here. ^[raw/articles/src.md]\n`,
      );

      const r = await runDrift({
        vault: dir,
        affectedPages: true,
        fetchFn: async () => ok({ body: "changed content here" }),
      });

      expect(r.exitCode).toBe(32);
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/both.md"]);
      }
    });
  });

  it("normalizes page paths with forward slashes (G9)", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
    mkdirSync(join(dir, "concepts", "nested", "sub"), { recursive: true });
    writeFileSync(
      join(dir, "concepts", "nested", "sub", "deep.md"),
      `---\ntitle: Deep\ntype: concept\ncreated: 2026-05-05\nupdated: 2026-05-05\ntags: []\nsources:\n  - raw/articles/src.md\n---\n\nDeep concept.\n`,
    );

    const r = await runDrift({
      vault: dir,
      affectedPages: true,
      fetchFn: async () => ok({ body: "changed content here" }),
    });

    expect(r.exitCode).toBe(32);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.drifted[0].affected_pages).toEqual(["concepts/nested/sub/deep.md"]);
      expect(r.result.data.drifted[0].affected_pages![0]).not.toContain("\\");
    }
  });

  it("gracefully handles vault with zero typed pages emitting empty arrays without crashing", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));

    const r = await runDrift({
      vault: dir,
      affectedPages: true,
      fetchFn: async () => ok({ body: "changed content here" }),
    });

    expect(r.exitCode).toBe(32);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.drifted[0].affected_pages).toEqual([]);
    }
  });
});
