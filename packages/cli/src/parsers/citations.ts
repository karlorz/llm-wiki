const FENCE = /```[\s\S]*?```/g;

export interface CitationMarker { marker: string; target: string; }

export function extractCitationMarkers(body: string): CitationMarker[] {
  const stripped = body.replace(FENCE, "");
  const out: CitationMarker[] = [];
  const re = /\^\[(raw\/[^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.push({ marker: m[0], target: m[1] });
  }
  return out;
}

export function hasSourcesFooter(body: string): boolean {
  const stripped = body.replace(FENCE, "");
  return /^## Sources\s*$/m.test(stripped);
}

export function isLegacyCitationStyle(body: string): boolean {
  const markers = extractCitationMarkers(body);
  if (markers.length === 0) return false;

  if (!hasSourcesFooter(body)) return true;

  const stripped = body.replace(FENCE, "");
  const lines = stripped.split("\n");
  let inSources = false;

  for (const line of lines) {
    if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
    if (inSources) continue;

    // A line containing ONLY markers (and whitespace) is legacy style
    const markerOnly = line.replace(/\^\[(raw\/[^\]]+)\]/g, "").trim();
    if (markerOnly.length === 0 && /\^\[raw\//.test(line)) return true;

    // A line with markers NOT at the end (prose after markers) is legacy
    const lastMarkerIdx = line.lastIndexOf("^[raw/");
    if (lastMarkerIdx >= 0) {
      const afterLast = line.slice(lastMarkerIdx).replace(/\^\[(raw\/[^\]]+)\]/g, "").trim();
      if (afterLast.length > 0) return true;

      // Markers must follow sentence-ending punctuation on the same line
      const beforeFirst = line.slice(0, line.indexOf("^[raw/")).trim();
      if (beforeFirst.length > 0 && !/[.!?]\s*$/.test(beforeFirst)) return true;
    }
  }

  return false;
}

export function extractParagraphEndCitations(body: string): string[] {
  const stripped = body.replace(FENCE, "");
  const lines = stripped.split("\n");
  const targets: string[] = [];
  const markerRe = /\^\[(raw\/[^\]]+)\]/g;
  let inSources = false;

  for (const line of lines) {
    if (/^## Sources\b/.test(line.trim())) { inSources = true; continue; }
    if (inSources) continue;

    const markerOnly = line.replace(markerRe, "").trim();
    if (markerOnly.length === 0) continue; // marker-only line → not paragraph-end

    const markers = [...line.matchAll(markerRe)];
    if (markers.length === 0) continue;

    const lastMarkerIdx = line.lastIndexOf("^[raw/");
    const afterLast = line.slice(lastMarkerIdx).replace(markerRe, "").trim();
    if (afterLast.length > 0) continue;

    const beforeFirst = line.slice(0, line.indexOf("^[raw/")).trim();
    if (beforeFirst.length > 0 && !/[.!?]\s*$/.test(beforeFirst)) continue;

    for (const m of markers) targets.push(m[1]);
  }

  return targets;
}
