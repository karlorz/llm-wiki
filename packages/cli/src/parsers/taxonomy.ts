import yaml from "js-yaml";
import { ok, err, type Result } from "@skillwiki/shared";

const FENCE_RE = /^##\s+Tag Taxonomy\s*$[\s\S]*?```yaml\s*\n([\s\S]*?)\n```/m;

export function extractTaxonomy(schemaText: string): Result<string[]> {
  const m = schemaText.match(FENCE_RE);
  if (!m) return err("NO_TAXONOMY_BLOCK", { message: "No fenced YAML taxonomy block found in SCHEMA.md" });
  let parsed: unknown;
  try { parsed = yaml.load(m[1], { schema: yaml.JSON_SCHEMA }); }
  catch (e) { return err("INVALID_FRONTMATTER", { message: (e as Error).message }); }
  if (parsed === null || typeof parsed !== "object") {
    return err("INVALID_FRONTMATTER", { message: "taxonomy block is not an object" });
  }
  const tax = (parsed as Record<string, unknown>).taxonomy;
  if (!Array.isArray(tax)) {
    return err("INVALID_FRONTMATTER", { message: "taxonomy key missing or not an array" });
  }
  if (!tax.every(x => typeof x === "string")) {
    return err("INVALID_FRONTMATTER", { message: "taxonomy must be a list of strings" });
  }
  return ok(tax as string[]);
}
