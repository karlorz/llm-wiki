const FENCE = /```[\s\S]*?```/g;
const MARKER_RE = /\^\[(raw\/[^\]]+)\]/g;

export interface CitationMarker { marker: string; target: string; }

function stripFences(body: string): string {
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
  return /^## Sources\s*$/m.test(stripFences(body));
}

export function isLegacyCitationStyle(body: string): boolean {
  const markers = extractCitationMarkers(body);
  if (markers.length === 0) return false;

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
