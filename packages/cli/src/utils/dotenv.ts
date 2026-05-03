import { readFile } from "node:fs/promises";

const WHITELIST = new Set(["WIKI_PATH", "WIKI_LANG"]);

export type DotenvMap = Partial<Record<"WIKI_PATH" | "WIKI_LANG", string>>;

export async function parseDotenvFile(path: string): Promise<DotenvMap> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { return {}; }
  const out: DotenvMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!WHITELIST.has(key)) continue;
    if (value.length === 0) continue;
    (out as Record<string, string>)[key] = value;
  }
  return out;
}
