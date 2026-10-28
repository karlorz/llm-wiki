import { describe, expect, it } from "vitest";
import { admitWikiMirrorPath } from "../src/wiki-mirror-admit.js";
describe("shared wiki mirror admission", () => {
  it.each(["index.md", "SCHEMA.md", "log.md", "concepts/a.md", "concepts/secret-management.md", "projects/llm-wiki/architecture/credential-rotation.md", "entities/a.md", "projects/llm-wiki/README.md"])("admits maintained %s", path => {
    expect(admitWikiMirrorPath(path)).toEqual({ ok: true, path, family: "maintained" });
  });
  it("marks raw as create-only family", () => {
    expect(admitWikiMirrorPath("raw/transcripts/a.md")).toEqual({ ok: true, path: "raw/transcripts/a.md", family: "raw" });
  });
  it.each(["/concepts/a.md", "concepts\\a.md", "C:/concepts/a.md", "concepts/../a.md", "concepts//a.md", "concepts/AGENTS.md", "raw/agents.md", "projects/a/Claude.md", "concepts/GEMINI.MD", "concepts/.git/a.md", "concepts/Node_Modules/a.md", "concepts/a.md\0", "concepts/a\n.md", "projects/llm-wiki/.env", "concepts/.config/secret.md", "concepts/private.key", "raw/assets/a.png"])("denies without normalization: %s", path => {
    expect(admitWikiMirrorPath(path).ok).toBe(false);
  });
});
