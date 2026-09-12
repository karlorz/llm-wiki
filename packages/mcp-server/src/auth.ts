import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

export type TokenMap = Map<string, string>;

type TokenEntry = { buf: Buffer; hostId: string };
const tokenEntries = new WeakMap<TokenMap, TokenEntry[]>();

export function sha256Token(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function rememberEntries(map: TokenMap): TokenEntry[] {
  const entries: TokenEntry[] = [];
  for (const [hashHex, hostId] of map) {
    entries.push({ buf: Buffer.from(hashHex, "hex"), hostId });
  }
  tokenEntries.set(map, entries);
  return entries;
}

export function parseTokenMap(yamlText: string): TokenMap {
  const parsed = yaml.load(yamlText);
  const map = new Map<string, string>();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    rememberEntries(map);
    return map;
  }
  const records = parsed as Record<string, unknown>;
  const nested = records.tokens;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : records;
  for (const [hash, hostId] of Object.entries(source)) {
    if (hash === "tokens") continue;
    if (typeof hostId !== "string" || hostId.length === 0) continue;
    const normalized = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) continue;
    map.set(normalized, hostId);
  }
  rememberEntries(map);
  return map;
}

export function loadTokenMap(path: string): TokenMap {
  try {
    return parseTokenMap(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

export function resolveHostId(token: string, map: TokenMap): string | undefined {
  const digest = sha256Token(token);
  const entries = tokenEntries.get(map) ?? rememberEntries(map);
  let matched: string | undefined;
  for (const { buf, hostId } of entries) {
    if (buf.length !== digest.length) continue;
    if (timingSafeEqual(digest, buf)) matched = hostId;
  }
  return matched;
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export function unauthorizedHeaders(): { "WWW-Authenticate": "Bearer" } {
  return { "WWW-Authenticate": "Bearer" };
}
