/**
 * Parse the canonical active work-item directory shape:
 *   projects/{project}/work/{item}
 *
 * Returns the owning project slug and item name only for that exact shape.
 * Rejects missing segments, wrong roots (raw/, concepts/, ...), archive and
 * history paths, and any path with extra segments. This is the single shared
 * parser for active work-item paths used by `claims audit` ownership and
 * `stale` archive planning, so both commands agree on which paths are active
 * work and derive project/item identically.
 */
export function parseActiveWorkPath(
  relDir: string,
): { project: string; item: string } | undefined {
  const parts = relDir.split("/");
  if (parts.length !== 4) return undefined;
  if (parts[0] !== "projects") return undefined;
  if (parts[2] !== "work") return undefined;
  const project = parts[1];
  const item = parts[3];
  if (project === "" || item === "") return undefined;
  return { project, item };
}
