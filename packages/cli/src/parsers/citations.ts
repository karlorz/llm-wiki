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
