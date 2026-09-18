import { createHash, randomBytes } from "node:crypto";
import yaml from "js-yaml";
import type { TokenPrincipalRecord } from "./principal.js";

export const HOST_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

export type AppendHostHashError = "INVALID_HOST_ID" | "DUPLICATE_HOST_ID" | "DUPLICATE_HASH";

function parseAllowedVaults(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue;
    out.push(item.trim());
  }
  return out;
}

export function parseMcpTokenPrincipals(yamlText: string): Map<string, TokenPrincipalRecord> {
  const parsed = yaml.load(yamlText);
  const map = new Map<string, TokenPrincipalRecord>();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return map;
  }
  const records = parsed as Record<string, unknown>;
  const nested = records.tokens;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : records;
  for (const [hash, value] of Object.entries(source)) {
    if (hash === "tokens") continue;
    const normalized = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) continue;
    if (typeof value === "string" && value.length > 0) {
      map.set(normalized, { writerId: value });
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const rec = value as { writer_id?: unknown; host_id?: unknown; allowed_vaults?: unknown };
      const writerId =
        typeof rec.writer_id === "string"
          ? rec.writer_id
          : typeof rec.host_id === "string"
            ? rec.host_id
            : undefined;
      if (!writerId) continue;
      map.set(normalized, {
        writerId,
        allowedVaults: parseAllowedVaults(rec.allowed_vaults),
      });
    }
  }
  return map;
}

export function parseMcpTokenMap(yamlText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [hash, principal] of parseMcpTokenPrincipals(yamlText)) {
    map.set(hash, principal.writerId);
  }
  return map;
}

export function generateHostBearer(rng?: () => Buffer): { raw: string; hashHex: string } {
  const bytes = (rng ?? (() => randomBytes(32)))();
  const raw = bytes.toString("base64url");
  const hashHex = createHash("sha256").update(raw, "utf8").digest("hex");
  return { raw, hashHex };
}

export function appendHostHash(
  yamlText: string,
  hashHex: string,
  hostId: string,
): { yaml: string } | { error: AppendHostHashError } {
  if (!HOST_ID_RE.test(hostId)) {
    return { error: "INVALID_HOST_ID" };
  }
  const map = parseMcpTokenMap(yamlText);
  const normalizedHash = hashHex.trim().toLowerCase();
  if ([...map.values()].includes(hostId)) {
    return { error: "DUPLICATE_HOST_ID" };
  }
  if (map.has(normalizedHash)) {
    return { error: "DUPLICATE_HASH" };
  }
  return { yaml: yamlText.replace(/\s*$/, "") + `\n${normalizedHash}: ${hostId}\n` };
}

export function removeHostId(
  yamlText: string,
  hostId: string,
): { yaml: string } | { error: "NOT_FOUND" } {
  const map = parseMcpTokenMap(yamlText);
  if (![...map.values()].includes(hostId)) {
    return { error: "NOT_FOUND" };
  }
  const lines: string[] = [];
  for (const [hash, id] of map) {
    if (id !== hostId) lines.push(`${hash}: ${id}`);
  }
  return { yaml: lines.length > 0 ? `${lines.join("\n")}\n` : "" };
}
