import { describe, it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runIngest } from "../../src/commands/ingest.js";
import { extractTaxonomy } from "../../src/parsers/taxonomy.js";
import { lockPath } from "../../src/utils/sync-lock.js";

const realFetch = globalThis.fetch;

function makeIngestVault(tags: string[] = ["research"]) {
  const vault = mkdtempSync(join(tmpdir(), "sw-ingest-"));
  for (const d of ["raw/articles", "entities", "concepts", "comparisons", "queries"]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  writeFileSync(join(vault, "SCHEMA.md"), `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
${tags.map((tag) => `  - ${tag}`).join("\n")}
\`\`\`
`);
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Entities\n\n## Concepts\n\n## Comparisons\n\n## Queries\n");
  writeFileSync(join(vault, "log.md"), "# Vault Log\n");
  const source = join(vault, "source.txt");
  writeFileSync(source, "ingest fixture source");
  return { vault, source };
}

function vault(): string {
  return makeIngestVault().vault;
}

function readSchema(vault: string): string {
  return readFileSync(join(vault, "SCHEMA.md"), "utf8");
}

function countIndexLinks(vault: string, target: string): number {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (readFileSync(join(vault, "index.md"), "utf8").match(new RegExp(`\\[\\[${escaped}\\]\\]`, "g")) ?? []).length;
}

function countPublicationLogs(vault: string, target: string): number {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (readFileSync(join(vault, "log.md"), "utf8").match(new RegExp(`page-publish \\| ${escaped}`, "g")) ?? []).length;
}

function holdPublicationLock(vault: string): void {
  mkdirSync(join(vault, ".skillwiki"), { recursive: true });
  writeFileSync(lockPath(vault), JSON.stringify({
    session_id: "other-publisher",
    owner_token: "other-owner",
    acquired: "2026-07-13T00:00:00.000Z",
    expires: "2099-01-01T00:00:00.000Z",
  }));
}

function snapshotFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string, relative = "") => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const key = relative ? `${relative}/${name}` : name;
      if (lstatSync(path).isDirectory()) visit(path, key);
      else files[key] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return files;
}

describe("ingest", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
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
    // No content subdirectories created — ingest should mkdir -p.
    writeFileSync(join(v, "SCHEMA.md"), `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - research
\`\`\`
`);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
    writeFileSync(join(v, "log.md"), "# Vault Log\n");

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

  it("ingest admits a novel tag and publishes typed page, index, and log", async () => {
    const fixture = makeIngestVault(["research"]);
    const result = await runIngest({
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Novel Ingest",
      tags: ["research", "ingest-novel"],
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    const taxonomy = extractTaxonomy(readSchema(fixture.vault));
    expect(taxonomy).toMatchObject({ ok: true, data: expect.arrayContaining(["ingest-novel"]) });
    expect(existsSync(join(fixture.vault, "queries/novel-ingest.md"))).toBe(true);
    expect(countIndexLinks(fixture.vault, "queries/novel-ingest")).toBe(1);
    expect(countPublicationLogs(fixture.vault, "queries/novel-ingest.md")).toBe(1);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        raw_path: "raw/articles/novel-ingest.md",
        typed_path: "queries/novel-ingest.md",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        dry_run: false,
        humanHint: expect.any(String),
        publication: {
          target: "queries/novel-ingest.md",
          operation_id: expect.stringMatching(/^[0-9a-f]{64}$/),
          dry_run: false,
        },
      },
    });
  });

  it("leaves an immutable raw-only state when typed publication fails", async () => {
    const fixture = makeIngestVault(["research"]);
    holdPublicationLock(fixture.vault);

    const result = await runIngest({
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Blocked Ingest",
      tags: ["research", "blocked-novel"],
    });

    expect(result.exitCode).toBe(ExitCode.SYNC_LOCK_HELD);
    expect(existsSync(join(fixture.vault, "raw/articles/blocked-ingest.md"))).toBe(true);
    expect(existsSync(join(fixture.vault, "queries/blocked-ingest.md"))).toBe(false);
  });

  it("reuses identical immutable raw bytes without a durable retry change", async () => {
    const fixture = makeIngestVault(["research"]);
    const input = {
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Idempotent Ingest",
      tags: ["research"],
    };

    const first = await runIngest(input);
    const rawPath = join(fixture.vault, "raw/articles/idempotent-ingest.md");
    const raw = readFileSync(rawPath, "utf8");
    const lastOp = readFileSync(join(fixture.vault, ".skillwiki/last-op.json"), "utf8");
    const second = await runIngest(input);

    expect(first.exitCode).toBe(ExitCode.OK);
    expect(second).toMatchObject({
      exitCode: ExitCode.OK,
      result: { ok: true, data: { publication: { files_changed: [] } } },
    });
    expect(readFileSync(rawPath, "utf8")).toBe(raw);
    expect(readFileSync(join(fixture.vault, ".skillwiki/last-op.json"), "utf8")).toBe(lastOp);
  });

  it("rejects a conflicting immutable raw capture rather than overwriting it", async () => {
    const fixture = makeIngestVault(["research"]);
    const input = {
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Conflicting Ingest",
      tags: ["research"],
    };
    expect((await runIngest(input)).exitCode).toBe(ExitCode.OK);
    const rawPath = join(fixture.vault, "raw/articles/conflicting-ingest.md");
    const raw = readFileSync(rawPath, "utf8");
    writeFileSync(fixture.source, "different immutable source bytes");

    const conflict = await runIngest(input);

    expect(conflict).toMatchObject({
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: { ok: false, error: "INGEST_VALIDATION_FAILED" },
    });
    expect(readFileSync(rawPath, "utf8")).toBe(raw);
  });

  it("rejects a raw capture whose bytes differ despite retaining the source suffix", async () => {
    const fixture = makeIngestVault(["research"]);
    const input = {
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Exact Raw Ingest",
      tags: ["research"],
    };
    expect((await runIngest(input)).exitCode).toBe(ExitCode.OK);
    const rawPath = join(fixture.vault, "raw/articles/exact-raw-ingest.md");
    const raw = readFileSync(rawPath, "utf8");
    const tampered = raw.replace("\n\ningest fixture source", "\n\ninjected bytes\n\ningest fixture source");
    writeFileSync(rawPath, tampered);

    const result = await runIngest(input);

    expect(result).toMatchObject({
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: { ok: false, error: "INGEST_VALIDATION_FAILED" },
    });
    expect(readFileSync(rawPath, "utf8")).toBe(tampered);
  });

  it("does not overwrite an immutable raw capture during concurrent conflicting ingests", async () => {
    const fixture = makeIngestVault(["research"]);
    const sourceDir = mkdtempSync(join(tmpdir(), "sw-concurrent-source-"));
    const firstSource = join(sourceDir, "first.txt");
    const secondSource = join(sourceDir, "second.txt");
    writeFileSync(firstSource, "first immutable source bytes");
    writeFileSync(secondSource, "second immutable source bytes");
    holdPublicationLock(fixture.vault);
    const shared = {
      vault: fixture.vault,
      type: "query",
      title: "Concurrent Ingest",
      tags: ["research"],
    };

    const results = await Promise.all([
      runIngest({ ...shared, source: firstSource }),
      runIngest({ ...shared, source: secondSource }),
    ]);

    expect(results.filter((result) => result.exitCode === ExitCode.SYNC_LOCK_HELD)).toHaveLength(1);
    expect(results.filter((result) => result.exitCode === ExitCode.INGEST_VALIDATION_FAILED)).toHaveLength(1);
    const raw = readFileSync(join(fixture.vault, "raw/articles/concurrent-ingest.md"), "utf8");
    expect(raw.includes("first immutable source bytes") || raw.includes("second immutable source bytes")).toBe(true);
    expect(existsSync(join(fixture.vault, "queries/concurrent-ingest.md"))).toBe(false);
  });

  it("rejects a malformed existing raw capture as immutable source validation failure", async () => {
    const fixture = makeIngestVault(["research"]);
    const rawPath = join(fixture.vault, "raw/articles/malformed-ingest.md");
    const malformed = "---\nsource_url:\ningested: 2026-07-13\n";
    writeFileSync(rawPath, malformed);

    const result = await runIngest({
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Malformed Ingest",
      tags: ["research"],
    });

    expect(result).toMatchObject({
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: { ok: false, error: "INGEST_VALIDATION_FAILED" },
    });
    expect(readFileSync(rawPath, "utf8")).toBe(malformed);
    expect(existsSync(join(fixture.vault, "queries/malformed-ingest.md"))).toBe(false);
  });

  it("dry-run preserves legacy output fields and does not mutate publication state", async () => {
    const fixture = makeIngestVault(["research"]);
    const before = snapshotFiles(fixture.vault);

    const result = await runIngest({
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Dry Publication",
      tags: ["research", "dry-novel"],
      dryRun: true,
    });

    expect(result).toMatchObject({
      exitCode: ExitCode.OK,
      result: {
        ok: true,
        data: {
          raw_path: "raw/articles/dry-publication.md",
          typed_path: "queries/dry-publication.md",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          dry_run: true,
          humanHint: expect.stringContaining("DRY RUN"),
          publication: {
            target: "queries/dry-publication.md",
            taxonomy_added: ["dry-novel"],
            dry_run: true,
          },
        },
      },
    });
    expect(snapshotFiles(fixture.vault)).toEqual(before);
    expect(existsSync(lockPath(fixture.vault))).toBe(false);
    expect(existsSync(join(fixture.vault, ".skillwiki/last-op.json"))).toBe(false);
  });

  it("reuses the original capture date and operation ID after a midnight raw-only retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T23:59:00.000Z"));
    const fixture = makeIngestVault(["research"]);
    holdPublicationLock(fixture.vault);
    const input = {
      source: fixture.source,
      vault: fixture.vault,
      type: "query",
      title: "Midnight Retry",
      tags: ["research", "midnight-novel"],
    };

    const blocked = await runIngest(input);
    const rawPath = join(fixture.vault, "raw/articles/midnight-retry.md");
    const raw = readFileSync(rawPath, "utf8");
    rmSync(lockPath(fixture.vault));
    vi.setSystemTime(new Date("2026-07-14T00:01:00.000Z"));

    const retried = await runIngest(input);

    expect(blocked).toMatchObject({ exitCode: ExitCode.SYNC_LOCK_HELD, result: { ok: false } });
    expect(retried).toMatchObject({
      exitCode: ExitCode.OK,
      result: {
        ok: true,
        data: {
          publication: {
            operation_id: expect.any(String),
          },
        },
      },
    });
    vi.setSystemTime(new Date("2026-07-15T00:01:00.000Z"));
    const repeated = await runIngest(input);
    expect(repeated).toMatchObject({
      exitCode: ExitCode.OK,
      result: { ok: true, data: { publication: { files_changed: [] } } },
    });
    if (!retried.result.ok || !repeated.result.ok) return;
    expect(repeated.result.data.publication.operation_id).toBe(retried.result.data.publication.operation_id);
    expect(readFileSync(rawPath, "utf8")).toBe(raw);
    expect(readFileSync(join(fixture.vault, "queries/midnight-retry.md"), "utf8")).toContain("created: 2026-07-13");
  });
});
