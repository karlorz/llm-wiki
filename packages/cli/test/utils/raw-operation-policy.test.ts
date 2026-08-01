import { describe, expect, it } from "vitest";
import { authorizeRawOperation, classifyRawPath, lifecycleDestination } from "../../src/utils/raw-operation-policy.js";

describe("raw operation policy", () => {
  it("supports flexible asset paths without imposing a category taxonomy", () => {
    expect(classifyRawPath("raw/assets/github.com/project/diagram.png")).toMatchObject({
      ok: true,
      data: { category: "assets", storage: "asset", relativeWithinCategory: "github.com/project/diagram.png" },
    });
  });

  it("keeps archive and duplicate destinations inside lifecycle-first raw roots", () => {
    expect(lifecycleDestination("raw/articles/nested/source.md", "archive")).toEqual({ ok: true, data: "raw/archived/articles/nested/source.md" });
    expect(lifecycleDestination("raw/papers/paper.md", "deduplicate")).toEqual({ ok: true, data: "raw/duplicates/papers/paper.md" });
  });

  it("forbids raw rewrite and unattended removal", () => {
    expect(authorizeRawOperation({ operationClass: "rewrite", trigger: "attended-apply", source: "raw/articles/a.md" }).ok).toBe(false);
    expect(authorizeRawOperation({ operationClass: "destructive-remove", trigger: "report-only", source: "raw/articles/a.md" }).ok).toBe(false);
    expect(authorizeRawOperation({ operationClass: "destructive-remove", trigger: "attended-apply", source: "raw/articles/a.md", explicitExactTarget: true }).ok).toBe(true);
  });

  it("rejects legacy archive and outside-layer destinations", () => {
    expect(classifyRawPath("_archive/raw/articles/a.md").ok).toBe(false);
    expect(classifyRawPath("../raw/articles/a.md").ok).toBe(false);
  });
});
