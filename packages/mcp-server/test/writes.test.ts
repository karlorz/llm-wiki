import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCaptureMarkdown, slugify, wikiCapture, wikiLogAppend } from "../src/tools/writes.js";
import { ReconcileGate } from "../src/reconcile.js";
import { makeTempVault } from "./helpers.js";

function readyGate(): ReconcileGate {
  const gate = new ReconcileGate(async () => undefined);
  return gate;
}

describe("wiki_capture validation", () => {
  it("slugifies the title for a new transcripts path", () => {
    expect(slugify("Fix the template mismatch!")).toBe("fix-the-template-mismatch");
  });

  it("renders ad-hoc capture frontmatter that the raw schema accepts", () => {
    const md = renderCaptureMarkdown({
      kind: "idea",
      project: "llm-wiki",
      title: "Fix the template mismatch",
      content: "Body here",
      date: "2026-09-13",
    });
    expect(md).toContain("kind: idea");
    expect(md).toContain('project: "[[llm-wiki]]"');
    expect(md).toContain("ingested: 2026-09-13");
    expect(md).toContain("source_url: null");
    expect(md).toContain("# idea: Fix the template mismatch");
    expect(md).toContain("Body here");
  });

  it("rejects live credential patterns instead of writing", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => {
        throw new Error("put should not run");
      },
    }, {
      kind: "note",
      project: "llm-wiki",
      title: "leak",
      content: "Authorization: Bearer sk-live-super-secret-token-value-123456",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("SENSITIVE_CONTENT_DETECTED");
  });
});

describe("wiki_log_append", () => {
  it("appends a newest-last log entry after S3 success", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const put: string[] = [];
    const result = await wikiLogAppend({
      vaultDir: vault,
      hostId: "cursor-box",
      gate,
      putObject: async (path) => {
        put.push(path);
      },
    }, { content: "capture | note: hello from mcp" });
    expect(result.ok).toBe(true);
    expect(put).toEqual(["log.md"]);
    const log = await readFile(join(vault, "log.md"), "utf8");
    expect(log).toMatch(/## \[\d{4}-\d{2}-\d{2}\] capture \| note: hello from mcp/);
  });
});

describe("wiki_capture write", () => {
  it("creates a new transcripts file and does not touch existing pages", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => undefined,
      now: () => new Date("2026-09-13T12:00:00Z"),
    }, {
      kind: "note",
      project: "llm-wiki",
      title: "hello from mcp",
      content: "A capture body",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.path).toBe("raw/transcripts/2026-09-13-note-hello-from-mcp.md");
    expect(await readFile(join(vault, result.path), "utf8")).toContain("A capture body");
    await expect(access(join(vault, "concepts", "alpha.md"))).resolves.toBeUndefined();
  });
});
