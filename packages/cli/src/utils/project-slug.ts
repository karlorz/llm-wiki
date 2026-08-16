/**
 * Normalize a frontmatter project value to a bare project slug for exact
 * comparison against `--project <slug>`.
 *
 * Accepts `[[slug]]`, a quoted `"[[slug]]"` / `'[[slug]]'`, or a bare slug,
 * optionally with surrounding whitespace. Mirrors the canonical normalizer used
 * by `claims audit` so claim/`stale` project equality never relies on substring
 * matching and never lets a slug-prefix sibling (e.g. `acme-tools`) stand in for
 * an exact project (e.g. `acme`).
 */
export function normalizeProjectSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const slug = value
    .trim()
    .replace(/^\[\[/, "")
    .replace(/(?:\|[^\[\]]*)?\]\]$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return slug === "" ? undefined : slug;
}
