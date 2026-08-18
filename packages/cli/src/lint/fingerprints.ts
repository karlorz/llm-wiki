import type { LintOutput } from "./types.js";

/** Stable fingerprint: <bucket>\0<page>\0<normalized-detail> */
export function lintIssueFingerprint(bucket: string, item: unknown): string {
  const page = extractIssuePage(item);
  const detail = normalizeIssueDetail(item);
  return `${bucket}\0${page}\0${detail}`;
}

export function extractIssuePage(item: unknown): string {
  if (typeof item === "string") {
    // Common forms: "path.md: message" or bare path
    const m = item.match(/^([^:]+?)(?::\s|$)/);
    return (m?.[1] ?? item).trim();
  }
  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    for (const key of ["path", "file", "page", "relPath"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return "";
}

export function normalizeIssueDetail(item: unknown): string {
  if (typeof item === "string") {
    // Drop volatile whitespace only
    return item.replace(/\s+/g, " ").trim();
  }
  try {
    return JSON.stringify(item, Object.keys(item as object).sort());
  } catch {
    return String(item);
  }
}

/** Collect stable fingerprints for all error-severity issues in a lint output. */
export function collectLintErrorFingerprints(output: LintOutput): Set<string> {
  const fps = new Set<string>();
  for (const bucket of output.by_severity.error) {
    for (const item of bucket.items) {
      fps.add(lintIssueFingerprint(bucket.kind, item));
    }
  }
  return fps;
}
