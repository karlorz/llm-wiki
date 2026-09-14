import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseMcpTokenMap } from "./token-map.js";

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
  const map = parseMcpTokenMap(yamlText);
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

/** Replace live map entries and refresh timing-safe lookup buffers. */
export function replaceTokenMap(map: TokenMap, yamlText: string): void {
  map.clear();
  for (const [hash, hostId] of parseTokenMap(yamlText)) {
    map.set(hash, hostId);
  }
  rememberEntries(map);
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

export interface ResolveWriterDeps {
  tokenMap: TokenMap;
  oauthStore?: import("./oauth-store.js").OAuthStore;
}

export async function resolveWriter(
  header: string | undefined,
  deps: ResolveWriterDeps,
): Promise<{ writerId: string } | null> {
  const token = bearerToken(header);
  if (!token) return null;

  // 1. Try host-id token map first
  const hostId = resolveHostId(token, deps.tokenMap);
  if (hostId) {
    return { writerId: hostId };
  }

  // 2. Try OAuth access token if store is provided
  if (deps.oauthStore) {
    const tokenHash = sha256Token(token).toString("hex");
    const tokenEntry = await deps.oauthStore.getAccessToken(tokenHash);
    if (tokenEntry && tokenEntry.writerId) {
      return { writerId: tokenEntry.writerId };
    }
  }

  return null;
}

export function unauthorizedHeaders(resourceMetadata?: string): Record<string, string> {
  if (resourceMetadata) {
    return {
      "WWW-Authenticate": `Bearer realm="mcp", resource_metadata="${resourceMetadata}"`,
    };
  }
  return { "WWW-Authenticate": "Bearer" };
}
