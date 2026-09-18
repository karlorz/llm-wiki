import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TokenPrincipalRecord } from "./principal.js";
import { parseMcpTokenPrincipals } from "./token-map.js";

export type TokenMap = Map<string, string>;

type TokenEntry = { buf: Buffer; hostId: string; principal: TokenPrincipalRecord };
const tokenEntries = new WeakMap<TokenMap, TokenEntry[]>();
const tokenPrincipals = new WeakMap<TokenMap, Map<string, TokenPrincipalRecord>>();

export function sha256Token(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function rememberEntries(map: TokenMap, principals?: Map<string, TokenPrincipalRecord>): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const principalMap = principals ?? tokenPrincipals.get(map) ?? new Map<string, TokenPrincipalRecord>();
  for (const [hashHex, hostId] of map) {
    const principal = principalMap.get(hashHex) ?? { writerId: hostId };
    entries.push({ buf: Buffer.from(hashHex, "hex"), hostId, principal });
    principalMap.set(hashHex, principal);
  }
  tokenEntries.set(map, entries);
  tokenPrincipals.set(map, principalMap);
  return entries;
}

function writerMapFromPrincipals(principals: Map<string, TokenPrincipalRecord>): TokenMap {
  const map = new Map<string, string>();
  for (const [hash, principal] of principals) {
    map.set(hash, principal.writerId);
  }
  return map;
}

export function parseTokenMap(yamlText: string): TokenMap {
  const principals = parseMcpTokenPrincipals(yamlText);
  const map = writerMapFromPrincipals(principals);
  rememberEntries(map, principals);
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
  const principals = parseMcpTokenPrincipals(yamlText);
  for (const [hash, hostId] of writerMapFromPrincipals(principals)) {
    map.set(hash, hostId);
  }
  rememberEntries(map, principals);
}

export function resolveHostId(token: string, map: TokenMap): string | undefined {
  return resolveHostPrincipal(token, map)?.writerId;
}

export function resolveHostPrincipal(
  token: string,
  map: TokenMap,
): { writerId: string; hashHex: string; principal: TokenPrincipalRecord } | undefined {
  const digest = sha256Token(token);
  const hashHex = digest.toString("hex");
  const entries = tokenEntries.get(map) ?? rememberEntries(map);
  let matched: { writerId: string; hashHex: string; principal: TokenPrincipalRecord } | undefined;
  for (const { buf, hostId, principal } of entries) {
    if (buf.length !== digest.length) continue;
    if (timingSafeEqual(digest, buf)) {
      matched = { writerId: hostId, hashHex, principal };
    }
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
): Promise<{ writerId: string; source: "host" | "oauth"; principal?: TokenPrincipalRecord } | null> {
  const token = bearerToken(header);
  if (!token) return null;

  // 1. Try host-id token map first
  const host = resolveHostPrincipal(token, deps.tokenMap);
  if (host) {
    return { writerId: host.writerId, source: "host", principal: host.principal };
  }

  // 2. Try OAuth access token if store is provided
  if (deps.oauthStore) {
    const tokenHash = sha256Token(token).toString("hex");
    const tokenEntry = await deps.oauthStore.getAccessToken(tokenHash);
    if (tokenEntry && tokenEntry.writerId) {
      return { writerId: tokenEntry.writerId, source: "oauth" };
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
