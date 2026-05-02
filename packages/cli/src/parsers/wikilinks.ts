const FENCE = /`[^`]*`|```[\s\S]*?```/g;

export function extractBodyWikilinks(body: string): string[] {
  const stripped = body.replace(FENCE, "");
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const target = m[1].trim();
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}
