import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const CONFIG_KEYS = ["WIKI_PATH", "WIKI_LANG"] as const;
export type ConfigKey = typeof CONFIG_KEYS[number];
const _whitelist = new Set<string>(CONFIG_KEYS);

// Profile key validation: WIKI_{NAME}_PATH or WIKI_{NAME}_LANG where NAME is A-Z0-9_, max 32 chars
const PROFILE_PATH_RE = /^WIKI_([A-Z][A-Z0-9_]{0,31})_PATH$/;
const PROFILE_LANG_RE = /^WIKI_([A-Z][A-Z0-9_]{0,31})_LANG$/;
const PROFILE_DEFAULT_RE = /^WIKI_DEFAULT$/;

export function isValidWikiProfileKey(key: string): boolean {
  if (key === "WIKI_PATH" || key === "WIKI_LANG") return false;
  return PROFILE_PATH_RE.test(key) || PROFILE_LANG_RE.test(key) || PROFILE_DEFAULT_RE.test(key);
}

export function isProfileKey(key: string): boolean {
  return PROFILE_PATH_RE.test(key) || PROFILE_LANG_RE.test(key) || PROFILE_DEFAULT_RE.test(key);
}

export function profileKey(name: string, suffix: "PATH" | "LANG"): string {
  return `WIKI_${name.toUpperCase().replace(/-/g, "_").replace(/[^A-Z0-9_]/g, "")}_${suffix}`;
}

export type DotenvMap = Partial<Record<ConfigKey | string, string>>;

export function parseDotenvText(text: string): DotenvMap {
  const out: DotenvMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!_whitelist.has(key) && !isValidWikiProfileKey(key)) continue;
    if (value.length === 0) continue;
    (out as Record<string, string>)[key] = value;
  }
  return out;
}

export async function parseDotenvFile(path: string): Promise<DotenvMap> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { return {}; }
  return parseDotenvText(text);
}

export async function writeDotenv(
  filePath: string,
  entries: DotenvMap,
  originalContent?: string
): Promise<void> {
  const lines = originalContent !== undefined
    ? updateLines(originalContent, entries)
    : freshLines(entries);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

function freshLines(entries: DotenvMap): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out.push(`${key}=${value}`);
  }
  return out;
}

function updateLines(originalContent: string, entries: DotenvMap): string[] {
  let rawLines = originalContent.split(/\r?\n/);
  // Drop trailing empty string produced by split when content ends with \n
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines = rawLines.slice(0, -1);
  }
  const keysToWrite = new Set(Object.keys(entries));
  const out: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) { out.push(line); continue; }
    const key = trimmed.slice(0, eq).trim();
    if (keysToWrite.has(key)) {
      out.push(`${key}=${entries[key as keyof DotenvMap]}`);
      keysToWrite.delete(key);
    } else {
      out.push(line);
    }
  }

  // Append any keys not found in the original file
  for (const key of keysToWrite) {
    const value = entries[key as keyof DotenvMap];
    if (value !== undefined) out.push(`${key}=${value}`);
  }

  return out;
}
