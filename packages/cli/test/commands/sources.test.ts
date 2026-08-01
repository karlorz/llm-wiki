import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSourcesPending } from "../../src/commands/sources.js";

const dirs: string[] = [];
function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-sources-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  mkdirSync(join(root, "raw", "papers"), { recursive: true });
  mkdirSync(join(root, "concepts"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sources pending", () => {
  it("returns pending sources newest-first with exit zero and no mutation", async () => {
    const root = makeVault();
    const older = join(root, "raw", "articles", "2026-07-01-older.md");
    const newer = join(root, "raw", "papers", "2026-08-01-newer.md");
    const oldBytes = "---\ntitle: Older Codex\nsource_url: https://example.com/old\ningested: 2026-07-01\ningested_by: manual\n---\nOld\n";
    const newBytes = "---\ntitle: Newer Codex\nsource_url: https://example.com/new\ningested: 2026-08-01\ningested_by: manual\n---\nNew\n";
    writeFileSync(older, oldBytes);
    writeFileSync(newer, newBytes);
    const result = await runSourcesPending({ vault: root, today: "2026-08-02", match: "Codex" });
    expect(result.exitCode).toBe(0);
    if (!result.result.ok) throw new Error("pending failed");
    expect(result.result.data.items.map((item) => item.raw_path)).toEqual([
      "raw/papers/2026-08-01-newer.md",
      "raw/articles/2026-07-01-older.md",
    ]);
    expect(result.result.data.summary.pending).toBe(2);
    expect(readFileSync(older, "utf8")).toBe(oldBytes);
    expect(readFileSync(newer, "utf8")).toBe(newBytes);
  });

  it("excludes integrated sources unless requested", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "articles", "integrated.md"), "---\ntitle: Integrated\nsource_url: https://example.com\ningested: 2026-08-01\n---\nBody\n");
    writeFileSync(join(root, "concepts", "integrated.md"), "---\ntitle: Integrated\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/integrated.md]\n---\nBody\n");
    const hidden = await runSourcesPending({ vault: root, today: "2026-08-02" });
    expect(hidden.result.ok && hidden.result.data.items).toEqual([]);
    const shown = await runSourcesPending({ vault: root, today: "2026-08-02", includeIntegrated: true });
    expect(shown.result.ok && shown.result.data.items[0]?.lifecycle_status).toBe("integrated");
  });

  it("validates filters and returns the vault error unchanged", async () => {
    const badDate = await runSourcesPending({ vault: "/nope", since: "08/01/2026" });
    expect(badDate.exitCode).not.toBe(0);
    const badVault = await runSourcesPending({ vault: "/nope" });
    expect(badVault.exitCode).toBe(9);
  });

  it("summarizes the full match set while bounding items and unrelated diagnostics", async () => {
    const root = makeVault();
    writeFileSync(join(root, "raw", "articles", "a.md"), "---\ntitle: Alpha\nsource_url: https://example.com/a\ningested: 2026-08-01\n---\nA\n");
    writeFileSync(join(root, "raw", "articles", "b.md"), "---\ntitle: Beta\nsource_url: https://example.com/b\ningested: 2026-08-02\n---\nB\n");
    writeFileSync(join(root, "concepts", "broken.md"), "---\ntitle: Broken\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/missing.md]\n---\nBody ^[raw/articles/missing.md]\n");

    const result = await runSourcesPending({ vault: root, today: "2026-08-02", limit: 1 });
    if (!result.result.ok) throw new Error("pending failed");
    expect(result.result.data.items).toHaveLength(1);
    expect(result.result.data.summary.total).toBe(2);
    expect(result.result.data.diagnostics).toEqual([]);
  });
});
