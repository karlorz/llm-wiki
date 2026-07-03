const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /``[^`\n]+``|`[^`\n]+`/g;
const MARKER_RE = /\^\[(raw\/[^\]]+)\]/g;
const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

export interface CitationMarker { marker: string; target: string; }

function stripFences(body: string): string {
  return body.replace(FENCE, "").replace(INLINE_CODE, "");
}

const TILDE_FENCE = /~~~[\s\S]*?~~~/g;

/** Strip only fenced code blocks (``` and ~~~), preserving inline code. */
export function stripFencedBlocks(body: string): string {
  return body.replace(FENCE, "").replace(TILDE_FENCE, "");
}

export function extractCitationMarkers(body: string): CitationMarker[] {
  const stripped = stripFences(body);
  const out: CitationMarker[] = [];
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(stripped)) !== null) {
    if (m[1] === "raw/...") continue;
    out.push({ marker: m[0], target: m[1] });
  }
  return out;
}

export function hasSourcesFooter(body: string): boolean {
  // Strip fenced blocks only — inline code must be preserved so that
  // backtick-wrapped text near ## Sources doesn't eat the header line.
  return /^## Sources\s*$/m.test(stripFencedBlocks(body));
}

export function isLegacyCitationStyle(body: string): boolean {
  const markers = extractCitationMarkers(body);
  if (markers.length === 0) return false;

  // Check for Sources footer on the ORIGINAL body (backticks intact).
  // Using stripFences here caused false positives when backtick-wrapped
  // text appeared near the ## Sources header.
  if (!hasSourcesFooter(body)) return true;

  const lines = stripFences(body.replace(FRONTMATTER, "")).split("\n");
  let inSources = false;
  let lastNonBlankWasTable = false;

  for (const line of lines) {
    if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
    if (inSources) continue;

    const matches = [...line.matchAll(MARKER_RE)];
    if (matches.length === 0) {
      if (line.trim().length > 0) lastNonBlankWasTable = /^\|/.test(line.trim());
      continue;
    }

    const markerOnly = line.replace(MARKER_RE, "").trim();
    if (markerOnly.length === 0 && !lastNonBlankWasTable) return true;

    lastNonBlankWasTable = false;
    const lastMatch = matches[matches.length - 1];
    const afterLast = line.slice(lastMatch.index! + lastMatch[0].length).replace(MARKER_RE, "").trim();
    if (afterLast.length > 0) return true;

    const beforeFirst = line.slice(0, matches[0].index!).trim();
    if (beforeFirst.length > 0 && !/[.!?]["'"]*\s*$/.test(beforeFirst)) return true;
  }

  return false;
}

/**
 * Detects orphaned citation markers that appear after the Sources section ends.
 *
 * The Sources section is defined as:
 * - Lines starting with "## Sources" header
 * - Followed by list items (- or *) containing citation markers
 * - Ends at first blank line after the last list item, or at file end
 *
 * Markers appearing after this section are considered orphaned.
 */
export function hasOrphanedCitations(body: string): boolean {
  const noFm = body.replace(FRONTMATTER, "");
  const stripped = stripFences(noFm);
  const lines = stripped.split("\n");
  const rawLines = noFm.split("\n");

  let inSources = false;
  let sourcesEnded = false;
  let sourcesStartLine = -1;
  let lastNonBlankInSources = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^## Sources\b/.test(trimmed)) {
      inSources = true;
      sourcesStartLine = i;
      continue;
    }

    if (!inSources || sourcesEnded) continue;

    // In Sources section - track what we see
    if (trimmed.length === 0) {
      // Blank line - Sources section ends here if we've seen content before
      if (lastNonBlankInSources >= 0) {
        sourcesEnded = true;
      }
      continue;
    }

    // Check if this is valid Sources content (list item with citation)
    const isListItem = /^\s*(?:[-*]|\d+\.)\s+/.test(line);
    const hasMarker = /\^\[raw\//.test(line);
    // Check raw (unstripped) line for backtick-wrapped raw paths —
    // stripFences removes inline code so we must use rawLines[i] here
    const hasBacktickRawPath = /`raw\/[^`]+`/.test(rawLines[i]);

    if (isListItem && hasMarker) {
      // Valid list item in Sources section
      lastNonBlankInSources = i;
    } else if (isListItem && hasBacktickRawPath) {
      // Backtick-wrapped raw path in a list item — treat as valid citation
      lastNonBlankInSources = i;
    } else if (hasMarker && !isListItem) {
      // Citation marker that is NOT a list item - this ends Sources section
      // and is itself an orphaned marker
      return true;
    } else {
      // Non-list, non-citation content ends Sources section
      sourcesEnded = true;
    }
  }

  // If no Sources section found, nothing is orphaned (legacy check handles this)
  if (sourcesStartLine === -1) return false;

  // Check for orphaned markers after Sources section ended
  if (sourcesEnded) {
    const scanStart = Math.max(lastNonBlankInSources + 1, sourcesStartLine + 1);
    for (let i = scanStart; i < lines.length; i++) {
      if (/\^\[raw\//.test(lines[i])) {
        return true;
      }
    }
  }

  return false;
}

/** Detect [[raw/...]] wikilinks in body text — should be ^[raw/...] citations instead. */
export function hasWikilinkCitations(body: string): boolean {
  const stripped = stripFences(body);
  return /\[\[raw\/[^\]]+\]\]/.test(stripped);
}

export function extractParagraphEndCitations(body: string): string[] {
  const lines = stripFences(body.replace(FRONTMATTER, "")).split("\n");
  const targets: string[] = [];
  let inSources = false;

  for (const line of lines) {
    if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
    if (inSources) continue;

    const markerOnly = line.replace(MARKER_RE, "").trim();
    if (markerOnly.length === 0) continue;

    const markers = [...line.matchAll(MARKER_RE)];
    if (markers.length === 0) continue;

    const lastMatch = markers[markers.length - 1];
    const afterLast = line.slice(lastMatch.index! + lastMatch[0].length).replace(MARKER_RE, "").trim();
    if (afterLast.length > 0) continue;

    const beforeFirst = line.slice(0, markers[0].index!).trim();
    if (beforeFirst.length > 0 && !/[.!?]["'"]*\s*$/.test(beforeFirst)) continue;

    for (const m of markers) targets.push(m[1]);
  }

  return targets;
}
