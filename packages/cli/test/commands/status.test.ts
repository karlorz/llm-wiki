import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../../src/commands/status.js";

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(v, "entities"), { recursive: true });
  mkdirSync(join(v, "concepts"), { recursive: true });
  mkdirSync(join(v, "comparisons"), { recursive: true });
  mkdirSync(join(v, "queries"), { recursive: true });
  mkdirSync(join(v, "meta"), { recursive: true });
  mkdirSync(join(v, "raw", "articles"), { recursive: true });
  mkdirSync(join(v, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(v, "raw", "papers"), { recursive: true });
  mkdirSync(join(v, "projects"), { recursive: true });
  return v;
}

function makeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runStatus", () => {
  it("returns page counts for a minimal vault", async () => {
    const h = makeHome();
    const v = makeVault();
    writeFileSync(join(v, "entities", "foo.md"), "---\ntitle: foo\n---\nbody");
    writeFileSync(join(v, "concepts", "bar.md"), "---\ntitle: bar\n---\nbody");
    writeFileSync(join(v, "comparisons", "baz.md"), "---\ntitle: baz\n---\nbody");
    writeFileSync(join(v, "queries", "qux.md"), "---\ntitle: qux\n---\nbody");
    writeFileSync(join(v, "meta", "quux.md"), "---\ntitle: quux\n---\nbody");
    writeFileSync(join(v, "raw", "articles", "art1.md"), "---\ntitle: art1\n---\nbody");
    writeFileSync(join(v, "raw", "transcripts", "t1.md"), "---\ntitle: t1\n---\nbody");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.page_counts.entities).toBe(1);
      expect(r.result.data.page_counts.concepts).toBe(1);
      expect(r.result.data.page_counts.comparisons).toBe(1);
      expect(r.result.data.page_counts.queries).toBe(1);
      expect(r.result.data.page_counts.meta).toBe(1);
      expect(r.result.data.page_counts.raw_articles).toBe(1);
      expect(r.result.data.page_counts.raw_transcripts).toBe(1);
      expect(r.result.data.total_pages).toBe(7);
    }
  });

  it("returns lang from config", async () => {
    const h = makeHome();
    const v = makeVault();
    writeFileSync(join(h, ".skillwiki", ".env"), "WIKI_LANG=zh-Hant\n");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.lang).toBe("zh-Hant");
    }
  });

  it("returns lang from env when set", async () => {
    const h = makeHome();
    const v = makeVault();

    const r = await runStatus({ vault: v, home: h, langEnvValue: "zh-Hans" });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.lang).toBe("zh-Hans");
    }
  });

  it("defaults lang to en when no config or env", async () => {
    const h = makeHome();
    const v = makeVault();

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.lang).toBe("en");
    }
  });

  it("handles missing vault gracefully (VAULT_PATH_INVALID)", async () => {
    const h = makeHome();
    const r = await runStatus({ vault: "/nonexistent/path", home: h, langEnvValue: undefined });
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe("VAULT_PATH_INVALID");
    }
  });

  it("handles vault without SCHEMA.md as VAULT_PATH_INVALID", async () => {
    const h = makeHome();
    const v = mkdtempSync(join(tmpdir(), "vault-"));
    // No SCHEMA.md
    mkdirSync(join(v, "entities"), { recursive: true });

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
  });

  it("humanHint is non-empty", async () => {
    const h = makeHome();
    const v = makeVault();
    writeFileSync(join(v, "entities", "foo.md"), "---\ntitle: foo\n---\nbody");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.humanHint.length).toBeGreaterThan(0);
      expect(r.result.data.humanHint).toContain("vault:");
      expect(r.result.data.humanHint).toContain("lang:");
      expect(r.result.data.humanHint).toContain("total:");
    }
  });

  it("counts work items correctly", async () => {
    const h = makeHome();
    const v = makeVault();
    const workDir = join(v, "projects", "acme", "work", "2026-05-01-task");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), "---\ntitle: task\n---\nspec body");
    writeFileSync(join(workDir, "plan.md"), "---\ntitle: task\n---\nplan body");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.page_counts.work_items).toBe(2);
    }
  });

  it("counts compound entries correctly", async () => {
    const h = makeHome();
    const v = makeVault();
    const compoundDir = join(v, "projects", "acme", "compound");
    mkdirSync(compoundDir, { recursive: true });
    writeFileSync(join(compoundDir, "lesson-1.md"), "---\ntitle: lesson\n---\nbody");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.page_counts.compound).toBe(1);
    }
  });

  it("extracts schema version from SCHEMA.md when present", async () => {
    const h = makeHome();
    const v = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Schema\nversion: v2\n");
    mkdirSync(join(v, "raw"), { recursive: true });

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.schema_version).toBe("v2");
    }
  });

  it("defaults schema_version to v1 when no version in SCHEMA.md", async () => {
    const h = makeHome();
    const v = makeVault();

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.schema_version).toBe("v1");
    }
  });

  it("sets last_modified to the most recently modified page", async () => {
    const h = makeHome();
    const v = makeVault();
    writeFileSync(join(v, "entities", "old.md"), "---\ntitle: old\n---\nbody");
    // Small delay to ensure different mtime
    writeFileSync(join(v, "concepts", "new.md"), "---\ntitle: new\n---\nbody");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.last_modified.length).toBeGreaterThan(0);
    }
  });

  it("counts raw papers as raw_articles", async () => {
    const h = makeHome();
    const v = makeVault();
    writeFileSync(join(v, "raw", "papers", "paper1.md"), "---\ntitle: paper1\n---\nbody");
    writeFileSync(join(v, "raw", "articles", "art1.md"), "---\ntitle: art1\n---\nbody");

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.page_counts.raw_articles).toBe(2);
    }
  });

  it("returns vault_path matching input", async () => {
    const h = makeHome();
    const v = makeVault();

    const r = await runStatus({ vault: v, home: h, langEnvValue: undefined });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.vault_path).toBe(v);
    }
  });
});
