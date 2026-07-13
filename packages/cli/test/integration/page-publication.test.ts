import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExitCode } from "@skillwiki/shared";
import { extractTaxonomy } from "../../src/parsers/taxonomy.js";

const BIN = join(__dirname, "..", "..", "dist", "cli.js");
const RAW_FIXTURE = `---
title: Fixture Source
source_url: https://example.invalid/source
ingested: 2026-07-13
---

Fixture source body.
`;

interface CliProcessResult {
  status: number;
  stdout: string;
  stderr: string;
}

function schemaWithTags(tags: string[]): string {
  return [
    "# Vault Schema",
    "",
    "## Tag Taxonomy",
    "",
    "```yaml",
    "taxonomy:",
    ...tags.map((tag) => `  - ${tag}`),
    "```",
    "",
  ].join("\n");
}

function queryDraft(tags: string[], title = "Novel Query"): string {
  return [
    "---",
    `title: ${title}`,
    "aliases: []",
    "created: 2026-07-13",
    "updated: 2026-07-13",
    "type: query",
    `tags: [${tags.join(", ")}]`,
    "sources: [raw/articles/source.md]",
    "confidence: medium",
    "---",
    "",
    `# ${title}`,
    "",
    "## Overview",
    "",
    "Publication integration fixture.",
    "",
    "## Sources",
    "",
    "- ^[raw/articles/source.md]",
    "",
    "## Related",
    "",
    "- Fixture only.",
    "",
  ].join("\n");
}

function gitFixture(): { vault: string; draft: string } {
  const vault = mkdtempSync(join(tmpdir(), "page-publish-git-"));
  mkdirSync(join(vault, "queries"), { recursive: true });
  mkdirSync(join(vault, "raw", "articles"), { recursive: true });
  writeFileSync(join(vault, "SCHEMA.md"), schemaWithTags(["research"]));
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Queries\n");
  writeFileSync(join(vault, "log.md"), "# Vault Log\n");
  writeFileSync(join(vault, "raw", "articles", "source.md"), RAW_FIXTURE);
  execFileSync("git", ["init", "-b", "main", vault]);
  execFileSync("git", ["-C", vault, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", vault, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", vault, "add", "-A"]);
  execFileSync("git", ["-C", vault, "commit", "-m", "baseline"]);
  const draftDir = mkdtempSync(join(tmpdir(), "page-publish-draft-"));
  const draft = join(draftDir, "novel.md");
  writeFileSync(draft, queryDraft(["research", "novel-integration"]));
  return { vault, draft };
}

function writeDraft(tags: string[], title: string, filename: string): string {
  const draftDir = mkdtempSync(join(tmpdir(), "page-publish-concurrent-draft-"));
  const draft = join(draftDir, filename);
  writeFileSync(draft, queryDraft(tags, title));
  return draft;
}

function spawnCli(args: string[]): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function publishWithContentionRetry(args: string[]): Promise<CliProcessResult> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await spawnCli(args);
    if (result.status !== ExitCode.SYNC_LOCK_HELD) return result;
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }
  throw new Error("publication lock remained contended after five bounded retries");
}

function parseCliOutput(result: CliProcessResult): Record<string, any> {
  expect(result.stdout).not.toBe("");
  return JSON.parse(result.stdout) as Record<string, any>;
}

function snapshot(paths: string[]): Array<{ bytes: string; mtimeMs: number }> {
  return paths.map((path) => ({ bytes: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs }));
}

function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function countTaxonomyTag(vault: string, tag: string): number {
  return readFileSync(join(vault, "SCHEMA.md"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line === `  - ${tag}`).length;
}

describe("built page publication", () => {
  it("publishes transactionally, preserves no-op bytes, and leaves direct bypasses blocked by lint-delta", async () => {
    const { vault, draft } = gitFixture();
    const publicationArgs = [
      "page", "publish", draft, vault,
      "--target", "queries/novel.md", "--write",
    ];

    const first = spawnSync(process.execPath, [BIN, ...publicationArgs], { encoding: "utf8" });
    expect(first.status).toBe(ExitCode.OK);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.taxonomy_added).toEqual(["novel-integration"]);

    const lint = spawnSync(
      process.execPath,
      [BIN, "lint", vault, "--only", "tag_not_in_taxonomy", "--summary"],
      { encoding: "utf8" },
    );
    expect(lint.status).toBe(ExitCode.OK);
    expect(JSON.parse(lint.stdout).data.summary.errors).toBe(0);

    const delta = spawnSync(
      process.execPath,
      [BIN, "sync", "lint-delta", vault, "--base-ref", "HEAD"],
      { encoding: "utf8" },
    );
    const deltaJson = JSON.parse(delta.stdout);
    expect(deltaJson.ok).toBe(true);
    expect(deltaJson.data.new_errors).toBe(0);
    expect([ExitCode.OK, ExitCode.LINT_HAS_WARNINGS]).toContain(delta.status);

    const materialized = [
      join(vault, "SCHEMA.md"),
      join(vault, "queries", "novel.md"),
      join(vault, "index.md"),
      join(vault, "log.md"),
    ];
    const beforeReplay = snapshot(materialized);
    const replay = spawnSync(process.execPath, [BIN, ...publicationArgs], { encoding: "utf8" });
    expect(replay.status).toBe(ExitCode.OK);
    expect(JSON.parse(replay.stdout).data.files_changed).toEqual([]);
    expect(snapshot(materialized)).toEqual(beforeReplay);
    expect(countMatches(readFileSync(join(vault, "log.md"), "utf8"), `<!-- skillwiki-page-publish:${parsed.data.operation_id} -->`)).toBe(1);

    const firstDraft = writeDraft(["research", "first-integration"], "First Concurrent Query", "first.md");
    const secondDraft = writeDraft(["research", "second-integration"], "Second Concurrent Query", "second.md");
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      publishWithContentionRetry([
        "page", "publish", firstDraft, vault,
        "--target", "queries/first.md", "--write",
      ]),
      publishWithContentionRetry([
        "page", "publish", secondDraft, vault,
        "--target", "queries/second.md", "--write",
      ]),
    ]);
    expect(firstConcurrent.status).toBe(ExitCode.OK);
    expect(secondConcurrent.status).toBe(ExitCode.OK);
    const firstConcurrentJson = parseCliOutput(firstConcurrent);
    const secondConcurrentJson = parseCliOutput(secondConcurrent);
    expect(readFileSync(join(vault, "queries", "first.md"), "utf8")).toContain("First Concurrent Query");
    expect(readFileSync(join(vault, "queries", "second.md"), "utf8")).toContain("Second Concurrent Query");
    expect(countTaxonomyTag(vault, "first-integration")).toBe(1);
    expect(countTaxonomyTag(vault, "second-integration")).toBe(1);
    const index = readFileSync(join(vault, "index.md"), "utf8");
    expect(countMatches(index, "[[queries/first]]")).toBe(1);
    expect(countMatches(index, "[[queries/second]]")).toBe(1);
    const log = readFileSync(join(vault, "log.md"), "utf8");
    expect(countMatches(log, `<!-- skillwiki-page-publish:${firstConcurrentJson.data.operation_id} -->`)).toBe(1);
    expect(countMatches(log, `<!-- skillwiki-page-publish:${secondConcurrentJson.data.operation_id} -->`)).toBe(1);

    const [tagA, tagB] = await Promise.all([
      publishWithContentionRetry([
        "tag", "reconcile", vault,
        "--page", "queries/prospective-a.md",
        "--tags", "prospective-a",
        "--write",
      ]),
      publishWithContentionRetry([
        "tag", "reconcile", vault,
        "--page", "queries/prospective-b.md",
        "--tags", "prospective-b",
        "--write",
      ]),
    ]);
    expect(tagA.status).toBe(ExitCode.OK);
    expect(tagB.status).toBe(ExitCode.OK);
    const finalTags = extractTaxonomy(readFileSync(join(vault, "SCHEMA.md"), "utf8"));
    expect(finalTags).toMatchObject({
      ok: true,
      data: expect.arrayContaining(["prospective-a", "prospective-b"]),
    });
    expect(countTaxonomyTag(vault, "prospective-a")).toBe(1);
    expect(countTaxonomyTag(vault, "prospective-b")).toBe(1);

    const schemaBeforeBypass = readFileSync(join(vault, "SCHEMA.md"), "utf8");
    writeFileSync(join(vault, "queries", "bypass.md"), queryDraft(["research", "bypass-unknown"], "Bypass Query"));
    const bypassDelta = spawnSync(
      process.execPath,
      [BIN, "sync", "lint-delta", vault, "--base-ref", "HEAD"],
      { encoding: "utf8" },
    );
    const bypassDeltaJson = JSON.parse(bypassDelta.stdout);
    expect(bypassDelta.status).toBe(ExitCode.LINT_HAS_ERRORS);
    expect(bypassDeltaJson.ok).toBe(true);
    expect(bypassDeltaJson.data.new_errors).toBeGreaterThan(0);
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toBe(schemaBeforeBypass);
    expect(countTaxonomyTag(vault, "bypass-unknown")).toBe(0);
  }, 60000);
});
