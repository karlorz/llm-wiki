import { normalizeVaultId } from "./vault-id.js";

/** Grok Bot Plugins → Configure field. Non-secret. Distinct from SKILLWIKI_MCP_TOKEN. */
export const SKILLWIKI_EXTRA_VAULTS_FIELD = "SKILLWIKI_EXTRA_VAULTS";

/** Bearer secret field. Never parse extra-vault opt-in from this name. */
export const SKILLWIKI_MCP_TOKEN_FIELD = "SKILLWIKI_MCP_TOKEN";

export type ExtraVaultsParse =
  | { ok: true; vaults: string[] }
  | { ok: false; error: "MALFORMED" | "WILDCARD"; message: string };

/**
 * Parse the client opt-in extra-vault list. Empty/undefined means default-only.
 * This is not an authorization control; server allowed_vaults remains the boundary.
 */
export function parseSkillwikiExtraVaults(raw: string | undefined): ExtraVaultsParse {
  if (raw === undefined) return { ok: true, vaults: [] };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, vaults: [] };

  const parts = trimmed.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  const vaults: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.includes("*")) {
      return { ok: false, error: "WILDCARD", message: "SKILLWIKI_EXTRA_VAULTS does not allow wildcards" };
    }
    const id = normalizeVaultId(part);
    if (!id) {
      return { ok: false, error: "MALFORMED", message: `invalid extra vault id: ${part}` };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    vaults.push(id);
  }
  return { ok: true, vaults };
}

/**
 * Client-side intersection: default is always selectable when authorized;
 * extras require both local opt-in and server allowed_vaults.
 */
export function selectableVaults(input: {
  extraVaults: readonly string[];
  allowedVaults: readonly string[];
  defaultVault: string;
}): string[] {
  const allowed = new Set(input.allowedVaults);
  const out: string[] = [];
  if (allowed.has(input.defaultVault)) out.push(input.defaultVault);
  for (const id of input.extraVaults) {
    if (id === input.defaultVault) continue;
    if (allowed.has(id)) out.push(id);
  }
  return out;
}
