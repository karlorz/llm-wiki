import yaml from "js-yaml";
import { ok, err, type Result } from "@skillwiki/shared";

export interface SplitResult {
  rawFrontmatter: string;
  body: string;
  bodyStart: number;
}

const FM_OPEN = /^---\r?\n/;

export function splitFrontmatter(text: string): Result<SplitResult> {
  if (!FM_OPEN.test(text)) return ok({ rawFrontmatter: "", body: text, bodyStart: 0 });
  const afterOpen = text.replace(FM_OPEN, "");
  const closeIdx = afterOpen.search(/\r?\n---\r?\n/);
  if (closeIdx === -1) return err("MISSING_CLOSING_DELIMITER");
  const rawFrontmatter = afterOpen.slice(0, closeIdx);
  const closeMatch = afterOpen.slice(closeIdx).match(/\r?\n---\r?\n/)!;
  const bodyStart = text.length - (afterOpen.length - closeIdx - closeMatch[0].length);
  const body = text.slice(bodyStart);
  return ok({ rawFrontmatter, body, bodyStart });
}

export function extractFrontmatter(text: string): Result<Record<string, unknown>> {
  const split = splitFrontmatter(text);
  if (!split.ok) return split;
  if (!split.data.rawFrontmatter) return ok({});
  try {
    const parsed = yaml.load(split.data.rawFrontmatter, { schema: yaml.JSON_SCHEMA });
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return ok({});
    return ok(parsed as Record<string, unknown>);
  } catch (e) {
    return err("INVALID_FRONTMATTER", { message: (e as Error).message });
  }
}
