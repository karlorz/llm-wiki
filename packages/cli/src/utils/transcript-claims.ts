/**
 * Exact raw-transcript claim index derived from work-item frontmatter.
 *
 * A raw transcript under `raw/transcripts/` is claimed when a work item
 * references its exact vault-relative path in `source:`, `sources:`, or
 * `closes:`. Dates, slugs, titles, and filename similarity never establish
 * ownership: only an exact path reference does.
 *
 * Diagnostics are additive and deterministic: malformed attempted
 * raw-transcript references and duplicate exact claims are reported without
 * changing claim ownership. Diagnostic data contains only vault-relative
 * path text, frontmatter field names, and work-item directories — never
 * file bodies or filesystem-absolute paths. Malformed attempted references
 * that are not safe single-line path-shaped evidence are echoed as a stable
 * redacted marker ({@link REDACTED_MALFORMED_REFERENCE}), so diagnostic
 * output never contains newlines/control characters or unbounded content.
 * Malformed diagnostics appear in input order; duplicate diagnostics follow,
 * one per duplicated path, with owners in input (first-claimant-first) order.
 */

export type ClaimField = "source" | "sources" | "closes";

/**
 * Stable marker emitted in place of an attempted reference that is not safe
 * to echo verbatim (contains control/newline characters, or exceeds the
 * bounded diagnostic length). Deliberately safe, short, and delimiter-free so
 * it never introduces newlines or unbounded content into output.
 */
export const REDACTED_MALFORMED_REFERENCE = "[redacted]";

/**
 * Upper bound on a diagnostic-eligible attempted reference. Real transcript
 * paths are short; anything longer cannot be a useful path-shaped reference
 * and is treated as arbitrary content and redacted.
 */
const MAX_DIAGNOSTIC_VALUE_LENGTH = 1024;

/**
 * Characters that must never appear in a canonical raw-transcript reference or
 * be echoed verbatim into diagnostic output: C0 controls (U+0000–U+001F,
 * including CR/LF/TAB), DEL (U+007F), C1 controls (U+0080–U+009F, including NEL
 * U+0085), and the Unicode line/paragraph separators U+2028/U+2029. These break
 * single-line output and can smuggle arbitrary body content into a "path".
 */
const UNSAFE_CHAR_RE = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;

/**
 * The trimmed attempted-reference text is safe to echo as diagnostic evidence
 * only when it is a single line with no control characters and within a
 * bounded length. Unsafe (e.g. multiline, or oversized / arbitrary) values are
 * replaced by {@link REDACTED_MALFORMED_REFERENCE} so diagnostic output never
 * carries body-like or unbounded content.
 */
export function safeDiagnosticValue(value: string): string {
  if (UNSAFE_CHAR_RE.test(value) || value.length > MAX_DIAGNOSTIC_VALUE_LENGTH) {
    return REDACTED_MALFORMED_REFERENCE;
  }
  return value;
}

export interface MalformedClaimDiagnostic {
  kind: "malformed";
  /** Work-item directory whose claim field held the malformed value. */
  relDir: string;
  /** Frontmatter field that held the malformed value. */
  field: ClaimField;
  /**
   * The attempted vault-relative reference text, trimmed, when it is safe
   * single-line evidence; otherwise {@link REDACTED_MALFORMED_REFERENCE};
   * never carries newlines/control characters or body content.
   */
  value: string;
}

export interface DuplicateClaimDiagnostic {
  kind: "duplicate";
  /** Exact transcript path claimed by more than one work item. */
  path: string;
  /** Work-item directories claiming the path, in input order. */
  owners: string[];
}

export type ClaimDiagnostic = MalformedClaimDiagnostic | DuplicateClaimDiagnostic;

export interface ClaimedTranscriptIndex {
  /** Exact vault-relative raw transcript paths and their owning work item. */
  claimedByPath: Map<string, string>;
  /** Deterministic claim-integrity diagnostics. */
  diagnostics: ClaimDiagnostic[];
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
  // A canonical reference is a single line of path-shaped text. Any control or
  // line-separator character (e.g. introduced by a literal block scalar whose
  // first line looks valid and whose last line ends .md) cannot be a real path:
  // accepting it would claim arbitrary body content. Reject so the value is
  // treated as a malformed attempt and redacted rather than echoed verbatim.
  if (UNSAFE_CHAR_RE.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * True when a string value attempts a raw-transcript reference (the
 * vault-relative prefix in either separator form) but fails normalization.
 * Unrelated strings and non-strings are not claims and not attempts, so
 * they are silently ignored rather than diagnosed.
 */
function isMalformedRawTranscriptAttempt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const attemptsTranscript =
    trimmed.startsWith("raw/transcripts/") || trimmed.startsWith("raw\\transcripts\\");
  return attemptsTranscript && normalizeRawTranscriptRef(trimmed) === undefined;
}

/**
 * Collect exact raw transcript references from a set of work items.
 *
 * `source:` is a single exact path. `sources:` and `closes:` may be a single
 * path or an array of paths. Malformed attempted references are reported as
 * diagnostics, never treated as claims. Duplicate exact claims across
 * distinct work items are reported with all owners; `claimedByPath` keeps
 * the later work item as owner. Well-formed paths are indexed regardless of
 * whether the transcript exists on disk, so the command layer can detect
 * dangling claims without filesystem access here.
 */
export function collectClaimedTranscripts(
  workItems: ClaimIndexSource[],
): ClaimedTranscriptIndex {
  const claimedByPath = new Map<string, string>();
  const diagnostics: ClaimDiagnostic[] = [];
  // Owners per path in input order, for duplicate detection.
  const ownersByPath = new Map<string, string[]>();

  for (const item of workItems) {
    const candidates: Array<{ field: ClaimField; value: unknown }> = [
      { field: "source", value: item.source },
    ];
    for (const field of ["sources", "closes"] as const) {
      const list = item[field];
      if (Array.isArray(list)) {
        for (const value of list) candidates.push({ field, value });
      } else if (list !== undefined) {
        candidates.push({ field, value: list });
      }
    }
    for (const { field, value } of candidates) {
      const normalized = normalizeRawTranscriptRef(value);
      if (normalized) {
        claimedByPath.set(normalized, item.relDir);
        const owners = ownersByPath.get(normalized);
        if (owners) {
          if (!owners.includes(item.relDir)) owners.push(item.relDir);
        } else {
          ownersByPath.set(normalized, [item.relDir]);
        }
      } else if (isMalformedRawTranscriptAttempt(value)) {
        diagnostics.push({
          kind: "malformed",
          relDir: item.relDir,
          field,
          value: safeDiagnosticValue(value.trim()),
        });
      }
    }
  }

  for (const [path, owners] of ownersByPath) {
    if (owners.length > 1) {
      diagnostics.push({ kind: "duplicate", path, owners });
    }
  }

  return { claimedByPath, diagnostics };
}
