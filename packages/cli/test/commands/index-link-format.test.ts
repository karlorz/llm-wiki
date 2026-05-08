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
  it("detects markdown links in index.md", async () => {
    const vault = makeVault({
      "index.md": "# Index\n## Concepts\n- [Foo](concepts/foo.md) — desc\n- [[concepts/bar]] — ok\n",
    });
    try {
      const res = await runIndexLinkFormat({ vault });
      expect(res.exitCode).toBe(0);
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) throw new Error("expected ok");
      expect(res.result.data.markdown_links).toHaveLength(1);
      expect(res.result.data.markdown_links[0].line).toBe(3);
      expect(res.result.data.markdown_links[0].text).toContain("[Foo](concepts/foo.md)");
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("returns empty when index.md has only wikilinks", async () => {
    const vault = makeVault({
      "index.md": "# Index\n## Concepts\n- [[concepts/foo]] — desc\n",
    });
    try {
      const res = await runIndexLinkFormat({ vault });
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) throw new Error("expected ok");
      expect(res.result.data.markdown_links).toHaveLength(0);
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("returns empty when index.md does not exist", async () => {
    const vault = makeVault({});
    try {
      const res = await runIndexLinkFormat({ vault });
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) throw new Error("expected ok");
      expect(res.result.data.markdown_links).toHaveLength(0);
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("detects multiple markdown links with correct line numbers", async () => {
    const vault = makeVault({
      "index.md": "# Index\n## Concepts\n- [Foo](concepts/foo.md) — desc\n- [[concepts/bar]] — ok\n- [Baz](entities/baz.md) — another\n",
    });
    try {
      const res = await runIndexLinkFormat({ vault });
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) throw new Error("expected ok");
      expect(res.result.data.markdown_links).toHaveLength(2);
      expect(res.result.data.markdown_links[0].line).toBe(3);
      expect(res.result.data.markdown_links[0].text).toContain("[Foo](concepts/foo.md)");
      expect(res.result.data.markdown_links[1].line).toBe(5);
      expect(res.result.data.markdown_links[1].text).toContain("[Baz](entities/baz.md)");
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("detects markdown link on a line that also has a wikilink", async () => {
    const vault = makeVault({
      "index.md": "# Index\n- [Foo](concepts/foo.md) and [[concepts/bar]] — mixed\n",
    });
    try {
      const res = await runIndexLinkFormat({ vault });
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) throw new Error("expected ok");
      expect(res.result.data.markdown_links).toHaveLength(1);
      expect(res.result.data.markdown_links[0].line).toBe(2);
      expect(res.result.data.markdown_links[0].text).toContain("[Foo](concepts/foo.md)");
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });

  it("includes humanHint listing markdown links when found", async () => {
    const vault = makeVault({
      "index.md": "# Index\n- [Foo](concepts/foo.md)\n",
    });
    try {
      const res = await runIndexLinkFormat({ vault });
      expect(res.result.ok).toBe(true);
      if (!res.result.ok) throw new Error("expected ok");
      expect(res.result.data.humanHint).toContain("markdown links found: 1");
      expect(res.result.data.humanHint).toContain("line 2");
    } finally { rmSync(vault, { recursive: true, force: true }); }
  });
});
