import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventorySources } from "../../src/utils/source-lifecycle.js";

const dirs: string[] = [];
function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-source-life-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  mkdirSync(join(root, "raw", "papers"), { recursive: true });
  mkdirSync(join(root, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(root, "concepts"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("source lifecycle inventory", () => {
  it("classifies canonical Web Clipper captures as valid pending without rewriting them", async () => {
    const root = makeVault();
    const path = join(root, "raw", "articles", "2026-08-01-example.md");
    const bytes = "---\ntitle: Example\nsource_url: https://example.com/article\ncreated: 2026-08-01\ningested: 2026-08-01\ningested_by: manual\n---\nCaptured body.\n";
    writeFileSync(path, bytes);
    const result = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(result.exitCode).toBe(0);
    expect(result.output?.items).toHaveLength(1);
    expect(result.output?.items[0]).toMatchObject({
      raw_path: "raw/articles/2026-08-01-example.md",
      lifecycle_status: "pending",
      schema_status: "valid",
      capture_channel: "manual",
      captured: "2026-08-01",
      date_source: "ingested",
      age_bucket: "fresh",
    });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("keeps a legacy source alias visible and derives integration only from typed knowledge", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "articles", "2026-08-01-legacy.md"), "---\ntitle: Legacy Clip\nsource: https://legacy.example/article\ncreated: 2026-08-01\n---\nLegacy body.\n");
    writeFileSync(join(root, "concepts", "legacy.md"), "---\ntitle: Legacy\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/2026-08-01-legacy.md]\n---\nMaintained.\n");
    const result = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(result.output?.items[0]).toMatchObject({
      source_url: "https://legacy.example/article",
      schema_status: "legacy",
      lifecycle_status: "integrated",
      capture_channel: "web-clipper-legacy",
      date_source: "created",
      referenced_by: ["concepts/legacy.md"],
    });
  });

  it("shows malformed articles with diagnostics but excludes transcripts", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "articles", "2026-07-01-broken.md"), "---\ntitle: [broken\n---\nBody\n");
    writeFileSync(join(root, "raw", "transcripts", "2026-08-02-task.md"), "---\nsource_url:\ningested: 2026-08-02\n---\nTask\n");
    const result = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(result.output?.items).toHaveLength(1);
    expect(result.output?.items[0]?.schema_status).toBe("invalid");
    expect(result.output?.diagnostics[0]?.code).toBe("source_schema_invalid");
  });

  it("projects the preserved 2026-08-01 legacy clipping as pending legacy evidence", async () => {
    const root = makeVault();
    const fixture = readFileSync(join(__dirname, "..", "fixtures", "legacy-web-clipper-2026-08-01.md"), "utf8");
    const filename = "2026-08-01-【拯救-5-6-sol-1】-codex-subagents.md";
    writeFileSync(join(root, "raw", "articles", filename), fixture);
    const result = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(result.output?.items[0]).toMatchObject({
      title: "【拯救 5.6 Sol（1）】开箱即用、快速高效、减少上下文腐烂的Codex子代理实践",
      source_url: "https://linux.do/t/topic/2578075",
      captured: "2026-08-01",
      date_source: "created",
      capture_channel: "web-clipper-legacy",
      schema_status: "legacy",
      lifecycle_status: "pending",
    });
    expect(readFileSync(join(root, "raw", "articles", filename), "utf8")).toBe(fixture);
  });
});
