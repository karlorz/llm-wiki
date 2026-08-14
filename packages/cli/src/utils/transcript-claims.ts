/**
 * Exact raw-transcript claim index derived from work-item frontmatter.
 *
 * A raw transcript under `raw/transcripts/` is claimed when a work item
 * references its exact vault-relative path in `source:`, `sources:`, or
 * `closes:`. Dates, slugs, titles, and filename similarity never establish
 * ownership: only an exact path reference does.
 */

export interface ClaimedTranscriptIndex {
  /** Exact vault-relative raw transcript paths and their owning work item. */
  claimedByPath: Map<string, string>;
}

export interface ClaimIndexSource {
  /** Vault-relative work item directory, e.g. projects/slug/work/2026-01-01-x. */
  relDir: string;
  /** Parsed work item spec frontmatter values. */
  source?: unknown;
  sources?: unknown;
  closes?: unknown;
}

/**
 * Normalize one frontmatter reference value into an exact vault-relative
 * path, or undefined when the value cannot be a raw transcript reference.
 */
export function normalizeRawTranscriptRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("raw/transcripts/") || !trimmed.endsWith(".md")) return undefined;
  // Reject paths that escape the transcript directory (e.g. ../) and
  // Windows-style separators; the vault-relative path is canonical.
  if (trimmed.includes("..") || trimmed.includes("\\")) return undefined;
  return trimmed;
}

/**
 * Collect exact raw transcript references from a set of work items.
 *
 * `source:` is a single exact path. `sources:` and `closes:` may be a single
 * path or an array of paths. Invalid or non-path values are ignored; the
 * caller decides whether malformed references deserve a separate finding.
 */
export function collectClaimedTranscripts(
  workItems: ClaimIndexSource[],
): ClaimedTranscriptIndex {
  const claimedByPath = new Map<string, string>();
  for (const item of workItems) {
    const candidates = [item.source];
    for (const list of [item.sources, item.closes]) {
      if (Array.isArray(list)) candidates.push(...list);
      else if (list !== undefined) candidates.push(list);
    }
    for (const value of candidates) {
      const normalized = normalizeRawTranscriptRef(value);
      if (normalized) claimedByPath.set(normalized, item.relDir);
    }
  }
  return { claimedByPath };
}
