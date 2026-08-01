import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRawAssetReferenceIndex } from "../../src/utils/raw-asset-reference-index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("raw asset reference index", () => {
  it("supports arbitrary nested stable asset paths and reports missing/external images", async () => {
    const root = mkdtempSync(join(tmpdir(), "sw-assets-"));
    dirs.push(root);
    writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
    mkdirSync(join(root, "raw", "articles"), { recursive: true });
    mkdirSync(join(root, "raw", "assets", "github.com", "project"), { recursive: true });
    mkdirSync(join(root, "raw", "assets", "other"), { recursive: true });
    writeFileSync(join(root, "raw", "assets", "github.com", "project", "diagram.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(root, "raw", "assets", "other", "diagram.png"), Buffer.from([4, 5, 6]));
    writeFileSync(join(root, "raw", "articles", "clip.md"), [
      "![[raw/assets/github.com/project/diagram.png]]",
      "![[raw/assets/missing.png]]",
      "![[diagram.png]]",
      "![remote](https://example.com/image.webp)",
    ].join("\n"));

    const index = await buildRawAssetReferenceIndex(root);
    expect(index.assets).toEqual([
      "raw/assets/github.com/project/diagram.png",
      "raw/assets/other/diagram.png",
    ]);
    expect(index.inbound.get("raw/assets/github.com/project/diagram.png")).toEqual(["raw/articles/clip.md"]);
    expect(index.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: "raw/assets/missing.png", exists: false, kind: "obsidian-embed" }),
      expect.objectContaining({ target: "diagram.png", exists: false, kind: "ambiguous-embed", candidates: expect.arrayContaining(["raw/assets/github.com/project/diagram.png", "raw/assets/other/diagram.png"]) }),
      expect.objectContaining({ target: "https://example.com/image.webp", kind: "external-image" }),
    ]));
  });
});
