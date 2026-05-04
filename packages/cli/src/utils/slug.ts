import type { VaultPage } from "./vault.js";

/** Build a case-insensitive slug map from vault pages. Returns Map<lowercaseSlug, originalSlug>. */
export function buildSlugMap(pages: VaultPage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of pages) {
    const slug = p.relPath.replace(/\.md$/, "").split("/").pop()!;
    map.set(slug.toLowerCase(), slug);
  }
  return map;
}
