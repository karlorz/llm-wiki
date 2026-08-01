import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";

function withoutMarkdownExtension(path: string): string {
  return path.endsWith(".md") ? path.slice(0, -3) : path;
}

function replacementFor(value: string, oldPath: string, newPath: string): string | null {
  const oldNoExtension = withoutMarkdownExtension(oldPath);
  const newNoExtension = withoutMarkdownExtension(newPath);
  if (value === oldPath) return newPath;
  if (value === oldNoExtension) return newNoExtension;
  if (value === `^[${oldPath}]`) return `^[${newPath}]`;
  if (value === `^[${oldNoExtension}]`) return `^[${newNoExtension}]`;
  return null;
}

function renderSources(values: string[]): string {
  if (values.length === 0) return "sources: []";
  return `sources:\n${values.map(value => `  - ${value}`).join("\n")}`;
}

export function rewriteRawSourceReferences(text: string, oldPath: string, newPath: string): {
  text: string;
  changed: boolean;
  sourcesBefore: string[];
  sourcesAfter: string[];
  bodyCitationCount: number;
} {
  const split = splitFrontmatter(text);
  const oldNoExtension = withoutMarkdownExtension(oldPath);
  const newNoExtension = withoutMarkdownExtension(newPath);
  const body = split.ok ? split.data.body : text;
  let rewrittenBody = body;
  let bodyCitationCount = 0;
  for (const [oldMarker, newMarker] of [
    [`^[${oldPath}]`, `^[${newPath}]`],
    [`^[${oldNoExtension}]`, `^[${newNoExtension}]`],
  ] as const) {
    const count = rewrittenBody.split(oldMarker).length - 1;
    if (count > 0) {
      rewrittenBody = rewrittenBody.replaceAll(oldMarker, newMarker);
      bodyCitationCount += count;
    }
  }

  if (!split.ok) {
    return { text: rewrittenBody, changed: rewrittenBody !== text, sourcesBefore: [], sourcesAfter: [], bodyCitationCount };
  }

  const frontmatter = extractFrontmatter(text);
  const sourcesBefore = frontmatter.ok && Array.isArray(frontmatter.data.sources)
    ? frontmatter.data.sources.filter((value): value is string => typeof value === "string")
    : [];
  const sourcesAfter = sourcesBefore.map(value => replacementFor(value, oldPath, newPath) ?? value);
  const sourcesChanged = sourcesBefore.some((value, index) => value !== sourcesAfter[index]);
  let rewrittenFrontmatter = split.data.rawFrontmatter;
  if (sourcesChanged) {
    rewrittenFrontmatter = rewrittenFrontmatter.replace(
      /^sources:\s*(?:\[[^\]]*\]|(?:\r?\n(?:\s*-\s.*))+)/m,
      renderSources(sourcesAfter),
    );
  }
  if (!sourcesChanged && rewrittenBody === body) {
    return { text, changed: false, sourcesBefore, sourcesAfter, bodyCitationCount };
  }
  const rewritten = `---\n${rewrittenFrontmatter}\n---${rewrittenBody}`;
  return {
    text: rewritten,
    changed: rewritten !== text,
    sourcesBefore,
    sourcesAfter,
    bodyCitationCount,
  };
}
