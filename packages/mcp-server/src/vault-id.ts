/** Canonical vault_id: same shape as host-id, never a path, prefix, or wildcard. */
export const VAULT_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

export const DEFAULT_VAULT_ID = "central";

export function isVaultId(value: string): boolean {
  return VAULT_ID_RE.test(value);
}

export function normalizeVaultId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!isVaultId(trimmed)) return null;
  return trimmed;
}
