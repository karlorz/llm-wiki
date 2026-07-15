import { describe, expect, it } from "vitest";
import { mergeLogConflictStages } from "../../src/utils/log-merge.js";

describe("mergeLogConflictStages", () => {
  it("keeps unique entries and dedupes page-publish markers", () => {
    const marker =
      "<!-- skillwiki-page-publish:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
    const merged = mergeLogConflictStages({
      base: "# Log\n",
      ours: `# Log\n\n## [2026-07-15] page-publish | concepts/a\n\nA\n${marker}\n`,
      theirs: `# Log\n\n## [2026-07-15] page-publish | concepts/a\n\nA\n${marker}\n\n## [2026-07-15] page-publish | concepts/b\n\nB\n`,
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.data.text.match(new RegExp(marker, "g"))).toHaveLength(1);
      expect(merged.data.text).toContain("concepts/b");
      expect(merged.data.deduplicated_operation_ids).toContain(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
    }
  });

  it("appends unmarked theirs blocks after ours", () => {
    const merged = mergeLogConflictStages({
      base: "# Log\n",
      ours: "# Log\n\n## [2026-07-15] local\n\nours body\n",
      theirs: "# Log\n\n## [2026-07-15] remote\n\ntheirs body\n",
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.data.text.indexOf("ours body")).toBeLessThan(merged.data.text.indexOf("theirs body"));
  });
});
