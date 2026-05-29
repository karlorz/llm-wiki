import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runSparseCommunity } from "../../src/commands/sparse-community.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "sw-sparse-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(v, "concepts"), { recursive: true });
  tmpDirs.push(v);
  return v;
}

/** Write a concept page whose body links to the given slugs via wikilinks. */
function page(v: string, slug: string, links: string[]): void {
  const body = links.map(l => `See [[${l}]].`).join("\n");
  writeFileSync(join(v, "concepts", `${slug}.md`), `# ${slug}\n\n${body}\n`);
}

describe("runSparseCommunity", () => {
  it("returns VAULT_PATH_INVALID for a bad vault", async () => {
    const r = await runSparseCommunity({ vault: "/no/such/vault/xyz" });
    expect(r.exitCode).toBe(9);
  });

  it("finds no sparse communities in a small dense vault", async () => {
    const v = makeVault();
    // triangle: cohesion 1.0, not sparse (and size 3 dense)
    page(v, "a", ["b", "c"]);
    page(v, "b", ["a", "c"]);
    page(v, "c", ["a", "b"]);
    const r = await runSparseCommunity({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.communities).toEqual([]);
  });

  it("flags a large low-density star cluster", async () => {
    const v = makeVault();
    const leaves: string[] = [];
    for (let i = 0; i < 13; i++) leaves.push(`l${i}`);
    page(v, "center", leaves);            // center → 13 leaves
    for (const l of leaves) page(v, l, ["center"]); // each leaf → center
    const r = await runSparseCommunity({ vault: v });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.communities.length).toBe(1);
      expect(r.result.data.communities[0].size).toBe(14);
      expect(r.result.data.communities[0].cohesion).toBeLessThan(0.15);
    }
  });
});
