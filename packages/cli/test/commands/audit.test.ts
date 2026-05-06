import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runAudit } from "../../src/commands/audit.js";

const F = (n: string) => join(__dirname, "..", "fixtures", "audit-vault", n);

describe("audit", () => {
  it("returns exit 0 for a clean page", async () => {
    const r = await runAudit({ file: F("concepts/clean.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.markers.every(m => m.resolved)).toBe(true);
      expect(r.result.data.sources_consistency.unused_sources).toEqual([]);
      expect(r.result.data.sources_consistency.missing_from_sources).toEqual([]);
    }
  });

  it("returns UNRESOLVED_MARKERS (11) for missing target", async () => {
    const r = await runAudit({ file: F("concepts/unresolved.md") });
    expect(r.exitCode).toBe(11);
  });

  it("returns SOURCES_INCONSISTENT (12) for unused sources", async () => {
    const r = await runAudit({ file: F("concepts/inconsistent.md") });
    expect(r.exitCode).toBe(12);
    if (r.result.ok) {
      expect(r.result.data.sources_consistency.unused_sources).toContain("raw/articles/y.md");
    }
  });

  it("returns exit 0 for new-style citation page with footer", async () => {
    const r = await runAudit({ file: F("concepts/newstyle.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.footer_consistency).toBeDefined();
      expect(r.result.data.footer_consistency!.missing_from_footer).toEqual([]);
      expect(r.result.data.footer_consistency!.extra_in_footer).toEqual([]);
    }
  });

  it("normalizes ^[...] format in sources frontmatter", async () => {
    // Sources frontmatter uses ^[raw/...] but markers extract raw/... paths
    // Audit should strip the ^[...] wrapper before comparing
    const r = await runAudit({ file: F("concepts/caret-sources.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.sources_consistency.unused_sources).toEqual([]);
      expect(r.result.data.sources_consistency.missing_from_sources).toEqual([]);
    }
  });
});
