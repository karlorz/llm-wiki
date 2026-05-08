import { describe, it, expect } from "vitest";
import { buildSlugMap } from "../../src/utils/slug.js";
import type { VaultPage } from "../../src/utils/vault.js";

function page(relPath: string, absPath?: string): VaultPage {
  return { relPath, absPath: absPath ?? `/vault/${relPath}` };
}

describe("buildSlugMap", () => {
  it("returns empty map for empty array", () => {
    const map = buildSlugMap([]);
    expect(map.size).toBe(0);
  });

  it("strips .md extension and uses last path segment as slug", () => {
    const map = buildSlugMap([page("entities/openai.md")]);
    expect(map.get("openai")).toBe("openai");
  });

  it("preserves original casing in value while lowercasing the key", () => {
    const map = buildSlugMap([page("concepts/RAG.md")]);
    expect(map.get("rag")).toBe("RAG");
    expect(map.has("RAG")).toBe(false); // key is lowercase only
  });

  it("handles deeply nested paths by taking the last segment", () => {
    const map = buildSlugMap([page("projects/llm-wiki/work/2026-05-09-fix/slug.md")]);
    expect(map.get("slug")).toBe("slug");
  });

  it("handles slugs with hyphens and underscores", () => {
    const pages = [page("entities/my-org.md"), page("concepts/some_topic.md")];
    const map = buildSlugMap(pages);
    expect(map.get("my-org")).toBe("my-org");
    expect(map.get("some_topic")).toBe("some_topic");
  });

  it("handles slugs with special characters", () => {
    const map = buildSlugMap([page("raw/articles/c++-faq.md")]);
    expect(map.get("c++-faq")).toBe("c++-faq");
  });

  it("handles Unicode slugs", () => {
    const map = buildSlugMap([page("entities/北京.md")]);
    const key = "北京".toLowerCase();
    expect(map.get(key)).toBe("北京");
  });

  it("last-writer-wins when two pages have the same lowercase slug", () => {
    const pages = [page("entities/OpenAI.md"), page("concepts/openai.md")];
    const map = buildSlugMap(pages);
    // Both map to key "openai"; last entry wins
    expect(map.get("openai")).toBe("openai");
    expect(map.size).toBe(1);
  });

  it("does not strip .md from the middle of a filename", () => {
    const map = buildSlugMap([page("entities/readme.md.bak.md")]);
    expect(map.get("readme.md.bak")).toBe("readme.md.bak");
  });

  it("handles filename without .md extension", () => {
    const map = buildSlugMap([page("entities/citation")]);
    expect(map.get("citation")).toBe("citation");
  });

  it("handles file at root level (no directory separators)", () => {
    const map = buildSlugMap([page("index.md")]);
    expect(map.get("index")).toBe("index");
  });

  it("builds map with multiple diverse pages", () => {
    const pages = [
      page("entities/OpenAI.md"),
      page("concepts/retrieval-augmented-generation.md"),
      page("raw/articles/2026-05-09-llm-survey.md"),
    ];
    const map = buildSlugMap(pages);
    expect(map.size).toBe(3);
    expect(map.get("openai")).toBe("OpenAI");
    expect(map.get("retrieval-augmented-generation")).toBe("retrieval-augmented-generation");
    expect(map.get("2026-05-09-llm-survey")).toBe("2026-05-09-llm-survey");
  });

  it("case-insensitive lookup: same slug different cases resolve to one entry", () => {
    const map = buildSlugMap([
      page("entities/GPT-4.md"),
      page("concepts/gpt-4.md"),
    ]);
    expect(map.size).toBe(1);
    // The value stored is the casing of whichever page was processed last
    expect(map.get("gpt-4")).toBe("gpt-4");
  });

  it("preserves slug value casing even when key is all lowercase", () => {
    const map = buildSlugMap([page("concepts/MiXeD-Case.md")]);
    expect(map.get("mixed-case")).toBe("MiXeD-Case");
  });
});
