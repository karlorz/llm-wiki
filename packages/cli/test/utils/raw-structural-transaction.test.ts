import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRawStructuralMove, planRawStructuralMove } from "../../src/utils/raw-structural-transaction.js";
import { readSourceRelocations } from "../../src/utils/source-relocations.js";
import { err } from "@skillwiki/shared";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-raw-move-"));
  dirs.push(root);
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  mkdirSync(join(root, "raw", "assets"), { recursive: true });
  return root;
}

describe("raw structural transaction", () => {
  it("previews without mutation and applies only with live target-bound approval", async () => {
    const root = vault();
    const source = "raw/articles/source.md";
    const destination = "raw/archived/articles/source.md";
    const bytes = Buffer.from("---\ntitle: immutable\n---\nBody\n", "utf8");
    writeFileSync(join(root, source), bytes);
    const plan = await planRawStructuralMove({ vault: root, operation: "archive", source, destination });
    expect(plan.ok).toBe(true);
    expect(existsSync(join(root, source))).toBe(true);
    expect(existsSync(join(root, destination))).toBe(false);
    if (!plan.ok) return;

    const stale = await applyRawStructuralMove({ vault: root, operation: "archive", source, destination, approve: "wrong" });
    expect(stale.ok).toBe(false);
    expect(existsSync(join(root, source))).toBe(true);

    const applied = await applyRawStructuralMove({ vault: root, operation: "archive", source, destination, approve: plan.data.approval_token, now: "2026-08-02T00:00:00.000Z" });
    expect(applied.ok).toBe(true);
    expect(existsSync(join(root, source))).toBe(false);
    expect(readFileSync(join(root, destination))).toEqual(bytes);
    const relocations = await readSourceRelocations(root);
    expect(relocations.ok && relocations.data[0]).toMatchObject({ previous_path: source, current_path: destination, operation: "archive" });
  });

  it("fails closed when source bytes change after preview", async () => {
    const root = vault();
    const source = "raw/articles/source.md";
    const destination = "raw/duplicates/articles/source.md";
    writeFileSync(join(root, source), "one");
    const plan = await planRawStructuralMove({ vault: root, operation: "deduplicate", source, destination });
    if (!plan.ok) throw new Error("plan failed");
    writeFileSync(join(root, source), "two");
    const result = await applyRawStructuralMove({ vault: root, operation: "deduplicate", source, destination, approve: plan.data.approval_token });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, source))).toBe(true);
    expect(existsSync(join(root, destination))).toBe(false);
  });

  it("refuses asset moves and cross-category lifecycle moves", async () => {
    const root = vault();
    writeFileSync(join(root, "raw", "assets", "image.png"), "asset");
    const assetMove = await planRawStructuralMove({
      vault: root,
      operation: "relocate",
      source: "raw/assets/image.png",
      destination: "raw/assets/renamed.png",
    });
    expect(assetMove.ok).toBe(false);
    if (!assetMove.ok) expect(assetMove.error).toBe("RAW_ASSET_PATH_FROZEN");

    writeFileSync(join(root, "raw", "articles", "source.md"), "source");
    const crossCategory = await planRawStructuralMove({
      vault: root,
      operation: "archive",
      source: "raw/articles/source.md",
      destination: "raw/archived/papers/source.md",
    });
    expect(crossCategory.ok).toBe(false);
    if (!crossCategory.ok) expect(crossCategory.error).toBe("RAW_MOVE_CATEGORY_MISMATCH");
  });

  it("rejects direct source symlinks and symlinked source parents", async () => {
    const root = vault();
    const outside = mkdtempSync(join(tmpdir(), "sw-raw-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "source.md"), "outside");
    symlinkSync(join(outside, "source.md"), join(root, "raw", "articles", "source.md"));
    const direct = await planRawStructuralMove({
      vault: root,
      operation: "archive",
      source: "raw/articles/source.md",
      destination: "raw/archived/articles/source.md",
    });
    expect(direct.ok).toBe(false);
    expect(readFileSync(join(outside, "source.md"), "utf8")).toBe("outside");

    rmSync(join(root, "raw", "articles"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "raw", "articles"));
    const parent = await planRawStructuralMove({
      vault: root,
      operation: "archive",
      source: "raw/articles/source.md",
      destination: "raw/archived/articles/source.md",
    });
    expect(parent.ok).toBe(false);
    expect(readFileSync(join(outside, "source.md"), "utf8")).toBe("outside");
  });

  it("rejects a symlinked destination parent", async () => {
    const root = vault();
    const outside = mkdtempSync(join(tmpdir(), "sw-raw-destination-outside-"));
    dirs.push(outside);
    writeFileSync(join(root, "raw", "articles", "source.md"), "source");
    symlinkSync(outside, join(root, "raw", "archived"));
    const result = await planRawStructuralMove({
      vault: root,
      operation: "archive",
      source: "raw/articles/source.md",
      destination: "raw/archived/articles/source.md",
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "raw", "articles", "source.md"))).toBe(true);
    expect(existsSync(join(outside, "articles", "source.md"))).toBe(false);
  });

  it("retains the source when relocation event creation fails", async () => {
    const root = vault();
    const source = "raw/articles/source.md";
    const destination = "raw/archived/articles/source.md";
    writeFileSync(join(root, source), "source");
    const plan = await planRawStructuralMove({ vault: root, operation: "archive", source, destination });
    if (!plan.ok) throw new Error("plan failed");
    const result = await applyRawStructuralMove({
      vault: root,
      operation: "archive",
      source,
      destination,
      approve: plan.data.approval_token,
      writeEvent: async () => err("WRITE_FAILED", { message: "injected event failure" }),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, source))).toBe(true);
    expect(readFileSync(join(root, destination), "utf8")).toBe("source");
  });
});
