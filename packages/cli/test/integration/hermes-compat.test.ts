import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const VAULT = join(__dirname, "..", "fixtures", "hermes-vault");

const HERMES_REQUIRED = ["title", "created", "updated", "type", "tags", "sources"];

describe("Hermes wire-compat", () => {
  it("typed-knowledge pages contain every Hermes-required field with original meaning", () => {
    const fm = yaml.load(splitFM(readFileSync(join(VAULT, "concepts/example.md"), "utf8"))) as Record<string, unknown>;
    for (const k of HERMES_REQUIRED) expect(fm).toHaveProperty(k);
    expect(fm.type).toBe("concept");
    expect(Array.isArray(fm.sources)).toBe(true);
  });

  it("raw pages preserve the Hermes raw shape (title, source_url, ingested, sha256)", () => {
    const fm = yaml.load(splitFM(readFileSync(join(VAULT, "raw/articles/note.md"), "utf8"))) as Record<string, unknown>;
    for (const k of ["title", "source_url", "ingested", "sha256"]) expect(fm).toHaveProperty(k);
  });

  it("additive fields (provenance, aliases) do NOT collide with Hermes names", () => {
    const reserved = new Set(["title", "created", "updated", "type", "tags", "sources", "confidence", "contested", "contradictions"]);
    for (const k of ["provenance", "provenance_projects", "aliases", "work_items"]) {
      expect(reserved.has(k)).toBe(false);
    }
  });
});

function splitFM(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter");
  return m[1];
}
