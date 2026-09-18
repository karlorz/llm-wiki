import { DEFAULT_VAULT_ID, isVaultId, normalizeVaultId } from "./vault-id.js";
import type { VaultRegistry } from "./vault-registry.js";

export interface TokenPrincipalRecord {
  writerId: string;
  /** Exact vault ids. Undefined means default vault only. No wildcards. */
  allowedVaults?: string[];
}

export interface Principal {
  writerId: string;
  defaultVault: string;
  allowedVaults: readonly string[];
}

export type VaultAuthErrorCode = "VAULT_MALFORMED" | "VAULT_UNKNOWN" | "VAULT_DISABLED" | "VAULT_UNAUTHORIZED";

export interface VaultAuthFailure {
  ok: false;
  error: VaultAuthErrorCode;
  message: string;
}

export function grantsHaveWildcard(vaults: readonly string[]): boolean {
  return vaults.some((id) => id.includes("*") || id.endsWith("/") || id.includes("/"));
}

export function normalizeGrants(
  writerId: string,
  granted: readonly string[] | undefined,
  registry: VaultRegistry,
): Principal {
  const defaultVault = registry.defaultVaultId || DEFAULT_VAULT_ID;
  if (!granted || granted.length === 0) {
    return { writerId, defaultVault, allowedVaults: [defaultVault] };
  }
  if (grantsHaveWildcard(granted)) {
    return { writerId, defaultVault, allowedVaults: [] };
  }
  const exact: string[] = [];
  const seen = new Set<string>();
  for (const raw of granted) {
    if (!isVaultId(raw) || seen.has(raw)) continue;
    seen.add(raw);
    exact.push(raw);
  }
  return { writerId, defaultVault, allowedVaults: exact };
}

export function handshakeFor(principal: Principal, registry: VaultRegistry): {
  default_vault: string;
  allowed_vaults: string[];
} {
  const advertised = principal.allowedVaults.filter((id) => {
    const entry = registry.entries.get(id);
    return Boolean(entry?.enabled);
  });
  return {
    default_vault: principal.defaultVault,
    allowed_vaults: advertised,
  };
}

export function mcpInstructionsHandshakeTrailer(handshake: {
  default_vault: string;
  allowed_vaults: readonly string[];
}): string {
  return [
    "",
    "### Vault handshake",
    `- default_vault: ${handshake.default_vault}`,
    `- allowed_vaults: ${handshake.allowed_vaults.join(", ") || "(none)"}`,
    "- omit vault= to use default_vault; unknown vaults fail closed",
  ].join("\n");
}

export function authorizeVaultSelection(input: {
  requested: string | undefined;
  principal: Principal;
  registry: VaultRegistry;
}): { ok: true; vaultId: string } | VaultAuthFailure {
  const raw = input.requested;
  if (raw === undefined || raw.trim() === "") {
    return authorizeExact(input.principal.defaultVault, input.principal, input.registry);
  }
  const vaultId = normalizeVaultId(raw);
  if (!vaultId) {
    return { ok: false, error: "VAULT_MALFORMED", message: "vault must be an exact vault_id" };
  }
  return authorizeExact(vaultId, input.principal, input.registry);
}

function authorizeExact(
  vaultId: string,
  principal: Principal,
  registry: VaultRegistry,
): { ok: true; vaultId: string } | VaultAuthFailure {
  const entry = registry.entries.get(vaultId);
  if (!entry) {
    return { ok: false, error: "VAULT_UNKNOWN", message: `unknown vault: ${vaultId}` };
  }
  if (!principal.allowedVaults.includes(vaultId)) {
    return { ok: false, error: "VAULT_UNAUTHORIZED", message: `vault not allowed: ${vaultId}` };
  }
  if (!entry.enabled) {
    return { ok: false, error: "VAULT_DISABLED", message: `vault disabled: ${vaultId}` };
  }
  return { ok: true, vaultId };
}
