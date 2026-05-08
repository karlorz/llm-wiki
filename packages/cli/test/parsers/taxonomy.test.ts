import { describe, it, expect } from "vitest";
import { extractTaxonomy } from "../../src/parsers/taxonomy.js";

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
});
