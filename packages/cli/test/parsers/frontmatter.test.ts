import { describe, it, expect } from "vitest";
import { extractFrontmatter, splitFrontmatter } from "../../src/parsers/frontmatter.js";

const SAMPLE = `---
title: "Hello"
tags: [a, b]
---
Body line 1
Body line 2
`;

describe("frontmatter", () => {
  it("extracts YAML object", () => {
    const r = extractFrontmatter(SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ title: "Hello", tags: ["a", "b"] });
  });

  it("splitFrontmatter returns body bytes after closing ---", () => {
    const r = splitFrontmatter(SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.bodyStart).toBe(SAMPLE.indexOf("Body line 1"));
      expect(r.data.body).toBe("Body line 1\nBody line 2\n");
    }
  });

  it("returns MISSING_CLOSING_DELIMITER when --- never closes", () => {
    const r = splitFrontmatter("---\ntitle: x\nbody\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("MISSING_CLOSING_DELIMITER");
  });

  it("returns empty fm + full body when no leading ---", () => {
    const r = extractFrontmatter("plain body\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({});
  });

  it("returns empty object when YAML parses to an array", () => {
    const r = extractFrontmatter("---\n- a\n- b\n---\nbody\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({});
  });

  it("returns empty object when YAML parses to null", () => {
    const r = extractFrontmatter("---\nnull\n---\nbody\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({});
  });

  it("returns INVALID_FRONTMATTER on unparseable YAML", () => {
    const r = extractFrontmatter("---\n: [bad\n---\nbody\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("INVALID_FRONTMATTER");
  });
});
