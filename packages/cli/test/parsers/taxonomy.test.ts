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

  it("returns ok with [] when the block is absent (caller decides if fatal)", () => {
    const r = extractTaxonomy(MISSING);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it("returns INVALID_FRONTMATTER on malformed YAML", () => {
    const r = extractTaxonomy(MALFORMED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });
});
