import { describe, expect, it } from "vitest";
import { buildWikilinkResolver } from "../../src/utils/wikilink-resolver.js";

function page(relPath: string) {
  return { absPath: `/vault/${relPath}`, relPath };
}

describe("wikilink resolver", () => {
  it("prefers an exact project artifact path, including retro pages", () => {
    const resolver = buildWikilinkResolver([
      page("projects/alpha/work/2026-08-01-fix/retro.md"),
      page("projects/beta/work/2026-08-01-fix/retro.md"),
    ]);

    expect(resolver.resolve("projects/alpha/work/2026-08-01-fix/retro")).toMatchObject({
      path: "projects/alpha/work/2026-08-01-fix/retro.md",
      ambiguous: false,
    });
  });

  it("fails closed for an ambiguous basename", () => {
    const resolver = buildWikilinkResolver([
      page("concepts/alpha.md"),
      page("entities/alpha.md"),
    ]);

    const result = resolver.resolve("alpha");
    expect(result.path).toBeUndefined();
    expect(result).toMatchObject({ ambiguous: true, reason: "ambiguous" });
  });

  it("does not resolve an unsupported project raw path through basename fallback", () => {
    const resolver = buildWikilinkResolver([
      page("projects/alpha/raw/transcripts/note.md"),
      page("concepts/note.md"),
    ]);

    const result = resolver.resolve("projects/alpha/raw/transcripts/note");
    expect(result.path).toBeUndefined();
    expect(result).toMatchObject({ ambiguous: false, reason: "unsupported" });
  });

  it("resolves the complete project artifact and history boundary", () => {
    const paths = [
      "projects/alpha/requirements/decision.md",
      "projects/alpha/architecture/adr.md",
      "projects/alpha/work/2026-08-01-fix/spec.md",
      "projects/alpha/work/2026-08-01-fix/plan.md",
      "projects/alpha/work/2026-08-01-fix/evidence.md",
      "projects/alpha/work/2026-08-01-fix/log.md",
      "projects/alpha/work/2026-08-01-fix/tasks.md",
      "projects/alpha/work/2026-08-01-fix/research.md",
      "projects/alpha/work/2026-08-01-fix/retro.md",
      "projects/alpha/work/2026-08-01-fix/design-notes.md",
      "projects/alpha/history/2026-08-01-fix/retro.md",
    ];
    const resolver = buildWikilinkResolver(paths.map(page));
    for (const path of paths) {
      expect(resolver.resolve(path.replace(/\.md$/, "")).path).toBe(path);
    }
  });

  it("keeps archived, draft, and internal paths out of the graph registry", () => {
    const resolver = buildWikilinkResolver([
      page("_archive/projects/alpha/work/old/spec.md"),
      page(".skillwiki/generated.md"),
      page("drafts/alpha.md"),
      page("tmp/alpha.md"),
      page("concepts/alpha.md"),
    ]);

    for (const target of [
      "_archive/projects/alpha/work/old/spec",
      ".skillwiki/generated",
      "drafts/alpha",
      "tmp/alpha",
    ]) {
      const result = resolver.resolve(target);
      expect(result.path).toBeUndefined();
      expect(result.reason).toBe("missing");
    }
    expect(resolver.resolve("alpha")).toMatchObject({ path: "concepts/alpha.md", ambiguous: false });
  });

  it("reports a missing supported project path distinctly from an unsupported one", () => {
    const resolver = buildWikilinkResolver([page("concepts/alpha.md")]);
    const missing = resolver.resolve("projects/alpha/work/2026-08-01-fix/spec");
    expect(missing.path).toBeUndefined();
    expect(missing).toMatchObject({ ambiguous: false, reason: "missing" });
    const unsupported = resolver.resolve("projects/alpha/raw/transcripts/note");
    expect(unsupported.path).toBeUndefined();
    expect(unsupported).toMatchObject({ ambiguous: false, reason: "unsupported" });
  });
});
