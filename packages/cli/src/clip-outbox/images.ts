export type ImageKind = "png" | "jpeg" | "gif" | "webp";

export interface MarkdownImageRef {
  raw: string;
  kind: "markdown" | "html" | "wikilink";
  target: string;
  local: boolean;
}

const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_IMAGE = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
const WIKI_EMBED = /!\[\[([^\]]+)\]\]/g;
const REF_DEF = /^\[([^\]]+)\]:\s+(\S+)/gm;
const REF_IMAGE = /!\[([^\]]*)\]\[([^\]]+)\]/g;

export function parseImageDependencies(markdown: string, sourceUrl?: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  const definitions = new Map<string, string>();
  for (const m of markdown.matchAll(REF_DEF)) {
    definitions.set(m[1]!.toLowerCase(), m[2]!);
  }
  for (const m of markdown.matchAll(MD_IMAGE)) {
    refs.push(makeRef(m[0]!, m[2]!, "markdown", sourceUrl));
  }
  for (const m of markdown.matchAll(REF_IMAGE)) {
    const href = definitions.get(m[2]!.toLowerCase());
    if (!href) continue;
    refs.push(makeRef(m[0]!, href, "markdown", sourceUrl));
  }
  for (const m of markdown.matchAll(HTML_IMAGE)) {
    refs.push(makeRef(m[0]!, m[1]!, "html", sourceUrl));
  }
  for (const m of markdown.matchAll(WIKI_EMBED)) {
    refs.push(makeRef(m[0]!, m[1]!.split("|")[0]!.trim(), "wikilink", sourceUrl));
  }
  return refs;
}

function makeRef(raw: string, target: string, kind: MarkdownImageRef["kind"], sourceUrl?: string): MarkdownImageRef {
  const trimmed = target.trim();
  const local = kind === "wikilink" || trimmed.startsWith("raw/assets/") || !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  let resolved = trimmed;
  if (!local && sourceUrl) {
    try {
      resolved = new URL(trimmed, sourceUrl).toString();
    } catch {
      resolved = trimmed;
    }
  }
  return { raw, kind, target: resolved, local };
}

export function sniffImageKind(bytes: Buffer): ImageKind | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF87a") return "gif";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return undefined;
}

export function extensionForKind(kind: ImageKind): string {
  return kind === "jpeg" ? "jpg" : kind;
}

export function pngPixelCount(bytes: Buffer): number | undefined {
  if (sniffImageKind(bytes) !== "png" || bytes.length < 24) return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width * height;
}

export function localAssetRelPath(target: string): string | undefined {
  const cleaned = target.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("raw/assets/")) return cleaned;
  if (cleaned.startsWith("/raw/assets/")) return cleaned.slice(1);
  return undefined;
}
