import { describe, it, expect } from "vitest";
import {
  extractTaxonomy,
  mergeTaxonomyConflict,
  parseTaxonomyDocument,
  reconcileTaxonomyDocument,
  taxonomyCommentForPage,
} from "../../src/parsers/taxonomy.js";

const VALID = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - research
  - timeline
  - person
\`\`\`

## Page Thresholds
`;

const MISSING = `# Vault Schema

## Layers

- raw/ — immutable
`;

const MALFORMED = `## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - [unbalanced
\`\`\`
`;

const LF_SCHEMA = [
  "# Vault Schema",
  "",
  "## Tag Taxonomy",
  "",
  "```yaml",
  "taxonomy:",
  "  - research",
  "```",
  "",
  "## Conventions",
  "keep me byte-for-byte",
  "",
].join("\n");

describe("extractTaxonomy", () => {
  it("returns the list when the fenced YAML block is present", () => {
    const r = extractTaxonomy(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual(["research", "timeline", "person"]);
  });

  it("returns NO_TAXONOMY_BLOCK error when the block is absent", () => {
    const r = extractTaxonomy(MISSING);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NO_TAXONOMY_BLOCK");
  });

  it("returns INVALID_FRONTMATTER on malformed YAML", () => {
    const r = extractTaxonomy(MALFORMED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });

  it("returns INVALID_FRONTMATTER when YAML parses to a non-object (scalar value)", () => {
    const scalar = `## Tag Taxonomy\n\n\`\`\`yaml\njust-a-string\n\`\`\`\n`;
    const r = extractTaxonomy(scalar);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });

  it("returns INVALID_FRONTMATTER when taxonomy key is missing or not an array", () => {
    const noKey = `## Tag Taxonomy\n\n\`\`\`yaml\nother:\n  - x\n\`\`\`\n`;
    const r = extractTaxonomy(noKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });

  it("returns INVALID_FRONTMATTER when taxonomy contains non-string items", () => {
    const mixed = `## Tag Taxonomy\n\n\`\`\`yaml\ntaxonomy:\n  - valid\n  - 123\n\`\`\`\n`;
    const r = extractTaxonomy(mixed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });

  it("locates only the fenced YAML below the exact taxonomy heading", () => {
    const parsed = parseTaxonomyDocument(LF_SCHEMA);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(LF_SCHEMA.slice(parsed.data.yamlStart, parsed.data.yamlEnd)).toBe(
      "taxonomy:\n  - research"
    );
    expect(parsed.data.tags).toEqual(["research"]);
    expect(parsed.data.newline).toBe("\n");
    expect(parsed.data.itemIndent).toBe("  ");
  });

  it("does not borrow a YAML fence from a later section", () => {
    const text = [
      "## Tag Taxonomy",
      "taxonomy documentation is missing its fence",
      "## Other YAML",
      "```yaml",
      "taxonomy:",
      "  - unrelated",
      "```",
    ].join("\n");
    expect(parseTaxonomyDocument(text)).toMatchObject({
      ok: false,
      error: "NO_TAXONOMY_BLOCK",
    });
  });

  it("splices one sorted block without changing surrounding bytes", () => {
    const result = reconcileTaxonomyDocument(LF_SCHEMA, {
      tags: ["zeta", "alpha"],
      comment: "# -- added 2026-07-13: research-cycle 325 taxonomy reconciliation --",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.added).toEqual(["alpha", "zeta"]);
    expect(result.data.text).toContain(
      "  # -- added 2026-07-13: research-cycle 325 taxonomy reconciliation --\n" +
      "  - alpha\n" +
      "  - zeta\n" +
      "```"
    );
    expect(result.data.text.endsWith("## Conventions\nkeep me byte-for-byte\n")).toBe(true);
  });

  it.each(["true", "false", "null", "123", "01", "1e2"])(
    "quotes YAML implicit scalar %s so it remains a string",
    (tag) => {
      const result = reconcileTaxonomyDocument(LF_SCHEMA, {
        tags: [tag],
        comment: "# -- added 2026-07-13: taxonomy reconciliation --",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(extractTaxonomy(result.data.text)).toEqual({
        ok: true,
        data: ["research", tag],
      });
    },
  );

  it("preserves CRLF when inserting a reconciliation block", () => {
    const schema = LF_SCHEMA.replace(/\n/g, "\r\n");
    const result = reconcileTaxonomyDocument(schema, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.text).toContain("  - alpha\r\n```\r\n");
    expect(result.data.text).not.toContain("  - alpha\n```");
    expect(result.data.text.endsWith("keep me byte-for-byte\r\n")).toBe(true);
  });

  it("uses the taxonomy block newline when unrelated text uses CRLF", () => {
    const schema = `${LF_SCHEMA}unrelated CRLF line\r\n`;
    const parsed = parseTaxonomyDocument(schema);
    expect(parsed).toMatchObject({
      ok: true,
      data: { tags: ["research"], newline: "\n" },
    });

    const result = reconcileTaxonomyDocument(schema, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(result).toMatchObject({ ok: true, data: { changed: true } });
    if (!result.ok) return;
    expect(extractTaxonomy(result.data.text)).toEqual({
      ok: true,
      data: ["research", "alpha"],
    });
    expect(result.data.text).toContain("  - alpha\n```\n");
    expect(result.data.text.endsWith("unrelated CRLF line\r\n")).toBe(true);
  });

  it("rejects inline taxonomy lists before constructing invalid YAML", () => {
    const inline = LF_SCHEMA.replace("taxonomy:\n  - research", "taxonomy: [research]");
    const result = reconcileTaxonomyDocument(inline, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "SCHEME_REJECTED",
      detail: { message: "taxonomy reconciliation requires a block-style taxonomy list" },
    });
  });

  it("uses indentation from the taxonomy list instead of an earlier YAML list", () => {
    const schema = LF_SCHEMA.replace(
      "taxonomy:\n  - research",
      "other:\n  - unrelated\ntaxonomy:\n    - research",
    );
    const first = reconcileTaxonomyDocument(schema, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(first).toMatchObject({ ok: true, data: { added: ["alpha"] } });
    if (!first.ok) return;
    expect(first.data.text).toContain("    - alpha\n```");
    expect(extractTaxonomy(first.data.text)).toEqual({
      ok: true,
      data: ["research", "alpha"],
    });

    expect(reconcileTaxonomyDocument(first.data.text, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    })).toMatchObject({ ok: true, data: { text: first.data.text, changed: false } });
  });

  it("is byte-identical on the second pass", () => {
    const first = reconcileTaxonomyDocument(LF_SCHEMA, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = reconcileTaxonomyDocument(first.data.text, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(second).toEqual({
      ok: true,
      data: {
        text: first.data.text,
        requested: ["alpha"],
        existing: ["research", "alpha"],
        missing: [],
        added: [],
        changed: false,
      },
    });
  });

  it("deduplicates requested tags before rendering or reporting additions", () => {
    const result = reconcileTaxonomyDocument(LF_SCHEMA, {
      tags: ["alpha", "research", "alpha"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        requested: ["alpha", "research"],
        missing: ["alpha"],
        added: ["alpha"],
      },
    });
    if (!result.ok) return;
    expect(result.data.text.match(/^  - alpha$/gm)).toHaveLength(1);
  });

  it("rejects invalid missing tags but permits legacy taxonomy values", () => {
    const legacy = LF_SCHEMA.replace("  - research", "  - LegacyTag");
    const invalid = reconcileTaxonomyDocument(legacy, {
      tags: ["not valid"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(invalid).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });

    const valid = reconcileTaxonomyDocument(legacy, {
      tags: ["new-tag"],
      comment: "# -- added 2026-07-13: taxonomy reconciliation --",
    });
    expect(valid).toMatchObject({
      ok: true,
      data: { existing: ["LegacyTag"], added: ["new-tag"] },
    });
  });

  it("uses the established comment format for research-cycle targets", () => {
    expect(
      taxonomyCommentForPage(
        "queries/2026-07-13-research-cycle-325-report.md",
        "2026-07-13",
      ),
    ).toEqual({
      ok: true,
      data: "# -- added 2026-07-13: research-cycle 325 taxonomy reconciliation --",
    });
  });
});

describe("mergeTaxonomyConflict", () => {
  it("merges disjoint taxonomy-only additions deterministically", () => {
    const base = LF_SCHEMA;
    const ours = reconcileTaxonomyDocument(base, {
      tags: ["alpha"],
      comment: "# -- added 2026-07-15: ours --",
    });
    const theirs = reconcileTaxonomyDocument(base, {
      tags: ["zeta"],
      comment: "# -- added 2026-07-15: theirs --",
    });
    if (!ours.ok || !theirs.ok) throw new Error("fixture failed");
    const merged = mergeTaxonomyConflict(base, ours.data.text, theirs.data.text);
    expect(merged).toMatchObject({
      ok: true,
      data: {
        tags: ["research", "alpha", "zeta"],
        added_from_ours: ["alpha"],
        added_from_theirs: ["zeta"],
      },
    });
    if (merged.ok) {
      expect(mergeTaxonomyConflict(base, merged.data.text, merged.data.text)).toMatchObject({
        ok: true,
        data: { text: merged.data.text },
      });
    }
  });

  it("rejects a conflict when either side edits bytes outside taxonomy", () => {
    const ours = LF_SCHEMA.replace("keep me byte-for-byte", "ours semantic edit");
    expect(mergeTaxonomyConflict(LF_SCHEMA, ours, LF_SCHEMA)).toMatchObject({
      ok: false,
      error: "SCHEME_REJECTED",
      detail: { reason: "non-taxonomy-change" },
    });
  });
});
