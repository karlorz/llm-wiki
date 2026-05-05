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
  const paragraphs = stripped.split(/\n\s*\n/);

  for (const para of paragraphs) {
    if (/^## Sources\b/.test(para.trim())) continue;

    const paraMarkerRe = /\^\[(raw\/[^\]]+)\]/g;
    const paraMarkers = [...para.matchAll(paraMarkerRe)];
    if (paraMarkers.length === 0) continue;

    const lastMarkerIdx = para.lastIndexOf("^[raw/");
    const afterLast = para.slice(lastMarkerIdx).replace(paraMarkerRe, "").trim();
    if (afterLast.length > 0) return true;

    const firstMarkerIdx = para.indexOf("^[raw/");
    const beforeFirst = para.slice(0, firstMarkerIdx).trim();
    if (beforeFirst.length > 0 && !/[.!?]\s*$/.test(beforeFirst)) return true;
  }

  return false;
}

export function extractParagraphEndCitations(body: string): string[] {
  const stripped = body.replace(FENCE, "");
  const paragraphs = stripped.split(/\n\s*\n/);
  const targets: string[] = [];
  const markerRe = /\^\[(raw\/[^\]]+)\]/g;

  for (const para of paragraphs) {
    if (/^## Sources\b/.test(para.trim())) continue;

    const markers = [...para.matchAll(markerRe)];
    if (markers.length === 0) continue;

    const lastMarkerIdx = para.lastIndexOf("^[raw/");
    const afterLast = para.slice(lastMarkerIdx).replace(markerRe, "").trim();
    if (afterLast.length > 0) continue;

    const firstMarkerIdx = para.indexOf("^[raw/");
    const beforeFirst = para.slice(0, firstMarkerIdx).trim();
    if (beforeFirst.length > 0 && !/[.!?]\s*$/.test(beforeFirst)) continue;

    for (const m of markers) targets.push(m[1]);
  }

  return targets;
}
