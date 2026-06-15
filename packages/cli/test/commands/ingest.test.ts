import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIngest } from "../../src/commands/ingest.js";

const realFetch = globalThis.fetch;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "sw-ingest-"));
  for (const d of ["raw/articles", "entities", "concepts", "comparisons", "queries"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("ingest", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("ingests a local file and creates raw + typed-knowledge page", async () => {
    const v = vault();
    const srcDir = mkdtempSync(join(tmpdir(), "sw-src-"));
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "This is the source content for testing.");

    const r = await runIngest({
      source: srcFile,
      vault: v,
      type: "concept",
      title: "Test Concept",
      tags: ["test", "example"],
      provenance: "research",
    });

    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.raw_path).toBe("raw/articles/test-concept.md");
      expect(r.result.data.typed_path).toBe("concepts/test-concept.md");
      expect(r.result.data.dry_run).toBe(false);
      expect(r.result.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // Verify raw file exists and has correct frontmatter
    const rawContent = readFileSync(join(v, "raw/articles/test-concept.md"), "utf8");
    expect(rawContent).toContain("source_url:");
    expect(rawContent).toContain("ingested_by: wiki-ingest");
    expect(rawContent).toContain("sha256:");
    expect(rawContent).toContain("This is the source content for testing.");

    // Verify typed-knowledge page exists and has correct frontmatter
    const typedContent = readFileSync(join(v, "concepts/test-concept.md"), "utf8");
    expect(typedContent).toContain('title: "Test Concept"');
    expect(typedContent).toContain("type: concept");
    expect(typedContent).toContain("created:");
    expect(typedContent).toContain("updated:");
    expect(typedContent).toContain("confidence: medium");
    expect(typedContent).toContain("provenance: research");
    expect(typedContent).toContain("- test");
    expect(typedContent).toContain("- example");
    expect(typedContent).toContain("# Test Concept");
    expect(typedContent).toContain("## Overview");
    expect(typedContent).toContain("## See also");
    expect(typedContent).toContain("## Sources");
    expect(typedContent).toContain("^[raw/articles/test-concept.md]");
    expect(typedContent).toContain("- raw/articles/test-concept.md");
  });

  it("ingests with --dry-run and creates no files", async () => {
    const v = vault();
    const srcDir = mkdtempSync(join(tmpdir(), "sw-src-"));
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "Dry run content.");

    const r = await runIngest({
      source: srcFile,
      vault: v,
      type: "entity",
      title: "Dry Run Test",
      dryRun: true,
    });

    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.dry_run).toBe(true);
      expect(r.result.data.humanHint).toContain("DRY RUN");
    }

    // Verify no files were created
    expect(existsSync(join(v, "raw/articles/dry-run-test.md"))).toBe(false);
    expect(existsSync(join(v, "entities/dry-run-test.md"))).toBe(false);
  });

  it("rejects URL with blocked host (INGEST_VALIDATION_FAILED)", async () => {
    const r = await runIngest({
      source: "https://169.254.169.4/metadata",
      vault: "/tmp/fake-vault",
      type: "concept",
      title: "Blocked Host Test",
    });

    expect(r.exitCode).toBe(41);
    if (!r.result.ok) {
      expect(r.result.error).toBe("INGEST_VALIDATION_FAILED");
    }
  });

  it("rejects URL with http scheme (INGEST_VALIDATION_FAILED)", async () => {
    const r = await runIngest({
      source: "http://example.com/unsecure",
      vault: "/tmp/fake-vault",
      type: "concept",
      title: "HTTP Test",
    });

    expect(r.exitCode).toBe(41);
    if (!r.result.ok) {
      expect(r.result.error).toBe("INGEST_VALIDATION_FAILED");
    }
  });

  it("rejects URL ingest when title slug conflicts with fetched source identity", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      "# Superpowers\n\nSuperpowers is a complete software development methodology.",
      { status: 200, headers: { "content-type": "text/markdown" } }
    )) as typeof fetch;

    const v = vault();
    const r = await runIngest({
      source: "https://raw.githubusercontent.com/obra/superpowers/main/README.md",
      vault: v,
      type: "concept",
      title: "Hermes LLM Wiki Skill v2.1.0",
    });

    expect(r.exitCode).toBe(41);
    if (!r.result.ok) {
      expect(r.result.error).toBe("INGEST_VALIDATION_FAILED");
      expect(r.result.detail).toMatchObject({ message: "source identity conflict" });
    }
    expect(existsSync(join(v, "raw/articles/hermes-llm-wiki-skill-v2-1-0.md"))).toBe(false);
  });

  it("allows URL ingest when title and fetched source identity agree", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      "# Superpowers\n\nSuperpowers is a complete software development methodology.",
      { status: 200, headers: { "content-type": "text/markdown" } }
    )) as typeof fetch;

    const v = vault();
    const r = await runIngest({
      source: "https://raw.githubusercontent.com/obra/superpowers/main/README.md",
      vault: v,
      type: "concept",
      title: "Superpowers",
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(join(v, "raw/articles/superpowers.md"))).toBe(true);
  });

  it("returns error for missing source", async () => {
    const r = await runIngest({
      source: "",
      vault: "/tmp/vault",
      type: "concept",
      title: "No Source",
    });

    expect(r.exitCode).toBe(4); // SCHEME_REJECTED
    if (!r.result.ok) {
      expect(r.result.error).toBe("SCHEME_REJECTED");
    }
  });

  it("returns error for missing type", async () => {
    const r = await runIngest({
      source: "/some/file.txt",
      vault: "/tmp/vault",
      type: "",
      title: "No Type",
    });

    expect(r.exitCode).toBe(4); // SCHEME_REJECTED
  });

  it("returns error for invalid type", async () => {
    const r = await runIngest({
      source: "/some/file.txt",
      vault: "/tmp/vault",
      type: "invalid_type",
      title: "Bad Type",
    });

    expect(r.exitCode).toBe(4); // SCHEME_REJECTED
    if (!r.result.ok) {
      expect(r.result.detail).toMatchObject({ message: expect.stringContaining("invalid_type") });
    }
  });

  it("returns error for missing title", async () => {
    const r = await runIngest({
      source: "/some/file.txt",
      vault: "/tmp/vault",
      type: "concept",
      title: "",
    });

    expect(r.exitCode).toBe(4); // SCHEME_REJECTED
  });

  it("returns error for invalid provenance", async () => {
    const r = await runIngest({
      source: "/some/file.txt",
      vault: "/tmp/vault",
      type: "concept",
      title: "Bad Provenance",
      provenance: "invalid",
    });

    expect(r.exitCode).toBe(4); // SCHEME_REJECTED
  });

  it("returns FILE_NOT_FOUND for missing local file", async () => {
    const r = await runIngest({
      source: "/no/such/file.txt",
      vault: "/tmp/vault",
      type: "concept",
      title: "Missing File",
    });

    expect(r.exitCode).toBe(2); // FILE_NOT_FOUND
    if (!r.result.ok) {
      expect(r.result.error).toBe("FILE_NOT_FOUND");
    }
  });

  it("returns VAULT_PATH_INVALID for empty vault", async () => {
    const r = await runIngest({
      source: "/some/file.txt",
      vault: "",
      type: "concept",
      title: "No Vault",
    });

    expect(r.exitCode).toBe(9); // VAULT_PATH_INVALID
  });

  it("handles each allowed type (entity, concept, comparison, query)", async () => {
    const typeDirs: Record<string, string> = {
      entity: "entities",
      concept: "concepts",
      comparison: "comparisons",
      query: "queries",
    };
    for (const type of ["entity", "concept", "comparison", "query"]) {
      const v = vault();
      const srcDir = mkdtempSync(join(tmpdir(), "sw-src-"));
      const srcFile = join(srcDir, `${type}.txt`);
      writeFileSync(srcFile, `Content for ${type}.`);

      const r = await runIngest({
        source: srcFile,
        vault: v,
        type,
        title: `${type} test`,
      });

      expect(r.exitCode).toBe(0);
      const dir = typeDirs[type];
      if (r.result.ok) {
        expect(r.result.data.typed_path).toBe(`${dir}/${type}-test.md`);
      }

      // Verify the typed-knowledge page was written
      const typedFile = join(v, dir, `${type}-test.md`);
      expect(existsSync(typedFile)).toBe(true);
    }
  });

  it("creates vault subdirectories if they do not exist", async () => {
    const v = mkdtempSync(join(tmpdir(), "sw-ingest-"));
    // No subdirectories created — ingest should mkdir -p

    const srcDir = mkdtempSync(join(tmpdir(), "sw-src-"));
    const srcFile = join(srcDir, "source.txt");
    writeFileSync(srcFile, "Auto-mkdir content.");

    const r = await runIngest({
      source: srcFile,
      vault: v,
      type: "concept",
      title: "Auto Mkdir",
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(join(v, "raw/articles/auto-mkdir.md"))).toBe(true);
    expect(existsSync(join(v, "concepts/auto-mkdir.md"))).toBe(true);
  });

  it("fetches URL content when source is a valid URL", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Fetched from the web.", { status: 200 })
    ) as any;

    const v = vault();
    const r = await runIngest({
      source: "https://example.com/article",
      vault: v,
      type: "entity",
      title: "Web Article",
    });

    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.raw_path).toBe("raw/articles/web-article.md");
      expect(r.result.data.typed_path).toBe("entities/web-article.md");
    }

    // Verify raw file contains the fetched content and source_url
    const rawContent = readFileSync(join(v, "raw/articles/web-article.md"), "utf8");
    expect(rawContent).toContain('source_url: "https://example.com/article"');
    expect(rawContent).toContain("Fetched from the web.");
  });

  it("generates correct sha256 for source content", async () => {
    const v = vault();
    const srcDir = mkdtempSync(join(tmpdir(), "sw-src-"));
    const srcFile = join(srcDir, "hash-test.txt");
    const body = "hash me please";
    writeFileSync(srcFile, body);

    const r = await runIngest({
      source: srcFile,
      vault: v,
      type: "concept",
      title: "Hash Test",
    });

    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // Verify the sha256 matches what hash.ts would produce for the same content
      const crypto = await import("node:crypto");
      const expected = crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
      expect(r.result.data.sha256).toBe(expected);
    }
  });

  it("handles tags as empty array when --tags not provided", async () => {
    const v = vault();
    const srcDir = mkdtempSync(join(tmpdir(), "sw-src-"));
    const srcFile = join(srcDir, "notags.txt");
    writeFileSync(srcFile, "No tags content.");

    const r = await runIngest({
      source: srcFile,
      vault: v,
      type: "concept",
      title: "No Tags",
    });

    expect(r.exitCode).toBe(0);

    const typedContent = readFileSync(join(v, "concepts/no-tags.md"), "utf8");
    expect(typedContent).toContain("tags:");
    expect(typedContent).toContain("[]");
  });

  it("rejects local source content containing sensitive values before writing", async () => {
    const v = vault();
    const source = join(v, "source.md");
    const secret = "hana_" + "dev_" + "A".repeat(43);
    writeFileSync(source, `# Source\n\nAccess key: ${secret}\n`);

    const r = await runIngest({
      source,
      vault: v,
      type: "query",
      title: "Secret Source",
      tags: ["security"],
    });

    expect(r.exitCode).toBe(51);
    expect(r.result.ok).toBe(false);
    expect(JSON.stringify(r.result)).not.toContain(secret);
    expect(existsSync(join(v, "raw", "articles", "secret-source.md"))).toBe(false);
    expect(existsSync(join(v, "queries", "secret-source.md"))).toBe(false);
  });

  it("rejects sensitive content even in dry-run mode", async () => {
    const v = vault();
    const source = join(v, "source.md");
    const secret = "Bearer " + "B".repeat(48);
    writeFileSync(source, `Authorization: ${secret}\n`);

    const r = await runIngest({
      source,
      vault: v,
      type: "query",
      title: "Secret Dry Run",
      tags: ["security"],
      dryRun: true,
    });

    expect(r.exitCode).toBe(51);
    expect(JSON.stringify(r.result)).not.toContain(secret);
  });
});
