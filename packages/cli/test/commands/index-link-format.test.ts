import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runIndexLinkFormat } from "../../src/commands/index-link-format.js";

function makeVault(structure: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ilf-"));
  for (const [path, content] of Object.entries(structure)) {
    const full = join(dir, path);
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

describe("runIndexLinkFormat", () => {
  it("detects markdown links in index.md", () => {
    const vault = makeVault({
      "index.md": "# Index\n## Concepts\n- [Foo](concepts/foo.md) — desc\n- [[concepts/bar]] — ok\n",
    });
    try {
      const r = runIndexLinkFormat({ vault });
      // Run async
      return (async () => {
        const res = await r;
        expect(res.exitCode).toBe(0);
        expect(res.result.ok).toBe(true);
        expect(res.result.data!.markdown_links).toHaveLength(1);
        expect(res.result.data!.markdown_links[0].line).toBe(3);
        expect(res.result.data!.markdown_links[0].text).toContain("[Foo](concepts/foo.md)");
      })();
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("returns empty when index.md has only wikilinks", () => {
    const vault = makeVault({
      "index.md": "# Index\n## Concepts\n- [[concepts/foo]] — desc\n",
    });
    try {
      return (async () => {
        const res = await runIndexLinkFormat({ vault });
        expect(res.result.ok).toBe(true);
        expect(res.result.data!.markdown_links).toHaveLength(0);
      })();
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("returns empty when index.md does not exist", () => {
    const vault = makeVault({});
    try {
      return (async () => {
        const res = await runIndexLinkFormat({ vault });
        expect(res.result.ok).toBe(true);
        expect(res.result.data!.markdown_links).toHaveLength(0);
      })();
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });
});
