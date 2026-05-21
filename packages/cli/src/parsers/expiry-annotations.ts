import type { isoDate } from "@skillwiki/shared";

export interface ExpiryAnnotation {
  page: string;
  heading: string;
  line: number;
  expires: string; // YYYY-MM-DD
  refresh?: "weekly" | "monthly" | "quarterly";
  source?: string;
}

const HEADING_RE = /^#{1,6}\s+(.+)$/;
const ANNOTATION_RE = /^<!--\s*expires:\s*(\d{4}-\d{2}-\d{2})(?:\s+refresh:\s*(weekly|monthly|quarterly))?(?:\s+source:\s*(\S+))?\s*-->$/;

const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!VALID_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
}

export function parseExpiryAnnotations(content: string, pagePath: string): ExpiryAnnotation[] {
  const lines = content.split("\n");
  const annotations: ExpiryAnnotation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(ANNOTATION_RE);
    if (!match) continue;

    const expires = match[1]!;
    if (!isValidDate(expires)) continue;

    // Annotation must immediately follow a heading line
    if (i === 0) continue;
    const prevLine = lines[i - 1]!;
    const headingMatch = prevLine.match(HEADING_RE);
    if (!headingMatch) continue;

    annotations.push({
      page: pagePath,
      heading: headingMatch[1]!.trim(),
      line: i + 1, // 1-indexed
      expires,
      refresh: match[2] as ExpiryAnnotation["refresh"],
      source: match[3],
    });
  }

  return annotations;
}
