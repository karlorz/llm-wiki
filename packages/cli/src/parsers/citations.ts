const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const MARKER_RE = /\^\[(raw\/[^\]]+)\]/g;

export interface CitationMarker { marker: string; target: string; }

function stripFences(body: string): string {
  return body.replace(FENCE, "").replace(INLINE_CODE, "");
}

/** Strip only fenced code blocks (```), preserving inline code. */
function stripFencedBlocks(body: string): string {
  return body.replace(FENCE, "");
}

export function extractCitationMarkers(body: string): CitationMarker[] {
  const stripped = stripFences(body);
  const out: CitationMarker[] = [];
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(stripped)) !== null) {
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

  const lines = stripFences(body).split("\n");
  let inSources = false;

  for (const line of lines) {
    if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
    if (inSources) continue;

    const markerOnly = line.replace(MARKER_RE, "").trim();
    if (markerOnly.length === 0 && /\^\[raw\//.test(line)) return true;

    const lastMarkerIdx = line.lastIndexOf("^[raw/");
    if (lastMarkerIdx >= 0) {
      const afterLast = line.slice(lastMarkerIdx).replace(MARKER_RE, "").trim();
      if (afterLast.length > 0) return true;

      const beforeFirst = line.slice(0, line.indexOf("^[raw/")).trim();
      if (beforeFirst.length > 0 && !/[.!?]\s*$/.test(beforeFirst)) return true;
    }
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
  const stripped = stripFences(body);
  const lines = stripped.split("\n");

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
    const isListItem = /^\s*[-*]\s+/.test(line);
    const hasMarker = /\^\[raw\//.test(line);

    if (isListItem && hasMarker) {
      // Valid list item in Sources section
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
    for (let i = lastNonBlankInSources + 1; i < lines.length; i++) {
      if (/\^\[raw\//.test(lines[i])) {
        return true;
      }
    }
  }

  return false;
}

export function extractParagraphEndCitations(body: string): string[] {
  const lines = stripFences(body).split("\n");
  const targets: string[] = [];
  let inSources = false;

  for (const line of lines) {
    if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
    if (inSources) continue;

    const markerOnly = line.replace(MARKER_RE, "").trim();
    if (markerOnly.length === 0) continue;

    const markers = [...line.matchAll(MARKER_RE)];
    if (markers.length === 0) continue;

    const lastMarkerIdx = line.lastIndexOf("^[raw/");
    const afterLast = line.slice(lastMarkerIdx).replace(MARKER_RE, "").trim();
    if (afterLast.length > 0) continue;

    const beforeFirst = line.slice(0, line.indexOf("^[raw/")).trim();
    if (beforeFirst.length > 0 && !/[.!?]\s*$/.test(beforeFirst)) continue;

    for (const m of markers) targets.push(m[1]);
  }

  return targets;
}
