import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReconcileGate } from "../src/reconcile.js";
import { handleWikiReadPage, MAX_READ_PAGE_BYTES } from "../src/tools/reads.js";
import { makeTempVault } from "./helpers.js";

function readyGate(): ReconcileGate {
  return new ReconcileGate(async () => undefined);
}

describe("wiki_read_page fail-closed", () => {
  it("returns FILE_NOT_FOUND for a missing path with no writer_id and no page write", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const alphaBefore = await readFile(join(vault, "concepts", "alpha.md"), "utf8");
    const result = await handleWikiReadPage(
      { vaultDir: vault, gate },
      { path: "concepts/does-not-exist.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("FILE_NOT_FOUND");
    expect(result.path).toBe("concepts/does-not-exist.md");
    expect((result as { markdown?: string }).markdown).toBeUndefined();
    expect((result as { writer_id?: string }).writer_id).toBeUndefined();
    expect(await readFile(join(vault, "concepts", "alpha.md"), "utf8")).toBe(alphaBefore);
  });

  it("returns PAGE_TOO_LARGE for an oversized page with no writer_id and no markdown body", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "concepts/oversized.md";
    const bytes = Buffer.concat([
      Buffer.from("---\ntitle: Oversized\ntype: concept\n---\n", "utf8"),
      Buffer.alloc(MAX_READ_PAGE_BYTES + 1, 0x61),
    ]);
    await writeFile(join(vault, rel), bytes);
    const alphaBefore = await readFile(join(vault, "concepts", "alpha.md"), "utf8");
    const result = await handleWikiReadPage({ vaultDir: vault, gate }, { path: rel });
    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "PAGE_TOO_LARGE") throw new Error("expected PAGE_TOO_LARGE");
    expect(result.path).toBe(rel);
    expect(result.byte_length).toBe(bytes.byteLength);
    expect((result as { markdown?: string }).markdown).toBeUndefined();
    expect((result as { writer_id?: string }).writer_id).toBeUndefined();
    expect(await readFile(join(vault, "concepts", "alpha.md"), "utf8")).toBe(alphaBefore);
  });
});
