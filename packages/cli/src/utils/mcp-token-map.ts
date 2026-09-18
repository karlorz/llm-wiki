import { createHash, randomBytes } from "node:crypto";
import yaml from "js-yaml";

export const HOST_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

export type AppendHostHashError =
  | "INVALID_HOST_ID"
  | "DUPLICATE_HOST_ID"
  | "DUPLICATE_HASH"
  | "INVALID_ALLOWED_VAULTS";

function writerIdFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rec = value as { writer_id?: unknown; host_id?: unknown };
    if (typeof rec.writer_id === "string" && rec.writer_id.length > 0) return rec.writer_id;
    if (typeof rec.host_id === "string" && rec.host_id.length > 0) return rec.host_id;
  }
  return undefined;
}

export function parseAllowedVaultIds(
  raw: readonly string[] | undefined,
): { vaults: string[] } | { error: "INVALID_ALLOWED_VAULTS" } {
  if (!raw || raw.length === 0) return { vaults: [] };
  const vaults: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = item.trim();
    if (!id) continue;
    if (id.includes("*") || id.includes("/") || !HOST_ID_RE.test(id)) {
      return { error: "INVALID_ALLOWED_VAULTS" };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    vaults.push(id);
  }
  return { vaults };
}

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
  for (const [hash, value] of Object.entries(source)) {
    if (hash === "tokens") continue;
    const writerId = writerIdFromValue(value);
    if (!writerId) continue;
    const normalized = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) continue;
    map.set(normalized, writerId);
  }
  return map;
}

export function generateHostBearer(rng?: () => Buffer): { raw: string; hashHex: string } {
  const bytes = (rng ?? (() => randomBytes(32)))();
  const raw = bytes.toString("base64url");
  const hashHex = createHash("sha256").update(raw, "utf8").digest("hex");
  return { raw, hashHex };
}

function formatHostRow(hashHex: string, hostId: string, allowedVaults: readonly string[]): string {
  if (allowedVaults.length === 0) {
    return `${hashHex}: ${hostId}\n`;
  }
  return `${hashHex}:\n  writer_id: ${hostId}\n  allowed_vaults: [${allowedVaults.join(", ")}]\n`;
}

export function appendHostHash(
  yamlText: string,
  hashHex: string,
  hostId: string,
  allowedVaults?: readonly string[],
): { yaml: string } | { error: AppendHostHashError } {
  if (!HOST_ID_RE.test(hostId)) {
    return { error: "INVALID_HOST_ID" };
  }
  const granted = parseAllowedVaultIds(allowedVaults);
  if ("error" in granted) return granted;
  const map = parseMcpTokenMap(yamlText);
  const normalizedHash = hashHex.trim().toLowerCase();
  if ([...map.values()].includes(hostId)) {
    return { error: "DUPLICATE_HOST_ID" };
  }
  if (map.has(normalizedHash)) {
    return { error: "DUPLICATE_HASH" };
  }
  return { yaml: yamlText.replace(/\s*$/, "") + `\n${formatHostRow(normalizedHash, hostId, granted.vaults)}` };
}
