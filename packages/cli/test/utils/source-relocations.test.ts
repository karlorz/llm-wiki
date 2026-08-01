import { describe, expect, it } from "vitest";
import { buildSourceRelocationProjection, resolveRelocatedSource } from "../../src/utils/source-relocations.js";

describe("source relocation projection", () => {
  it("resolves multiple historical addresses to the current preserved path", () => {
    const projection = buildSourceRelocationProjection([
      { operation_id: "a".repeat(64), operation: "rename", previous_path: "raw/articles/a.md", current_path: "raw/articles/b.md", source_sha256: "1".repeat(64), occurred_at: "2026-08-01T00:00:00.000Z" },
      { operation_id: "b".repeat(64), operation: "archive", previous_path: "raw/articles/b.md", current_path: "raw/archived/articles/b.md", source_sha256: "1".repeat(64), occurred_at: "2026-08-02T00:00:00.000Z" },
    ]);
    expect(resolveRelocatedSource("raw/articles/a.md", projection)).toBe("raw/archived/articles/b.md");
    expect(resolveRelocatedSource("raw/articles/b.md", projection)).toBe("raw/archived/articles/b.md");
  });
});
