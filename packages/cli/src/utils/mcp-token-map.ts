import { createHash, randomBytes } from "node:crypto";
import yaml from "js-yaml";

export const HOST_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

export type AppendHostHashError = "INVALID_HOST_ID" | "DUPLICATE_HOST_ID" | "DUPLICATE_HASH";

export function parseMcpTokenMap(yamlText: string): Map<string, string> {
  const parsed = yaml.load(yamlText);
  const map = new Map<string, string>();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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
