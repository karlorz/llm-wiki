import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/** Comma-separated absolute vault roots; unset = no extra restriction beyond SCHEMA.md scan. */
export function parseVaultAllowlist(envValue: string | undefined): string[] | null {
  if (envValue === undefined || envValue.trim() === "") return null;
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((p) => resolve(p));
}

export function vaultAllowedByList(vaultPath: string, allowlist: string[] | null): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  let canonical = vaultPath;
  try {
    canonical = realpathSync(vaultPath);
  } catch {
    canonical = resolve(vaultPath);
  }
  const resolved = resolve(canonical);
  return allowlist.some((root) => {
    const r = resolve(root);
    return resolved === r || resolved.startsWith(r + sep);
  });
}

export function getVaultAllowlistFromEnv(): string[] | null {
  return parseVaultAllowlist(process.env.SKILLWIKI_MCP_VAULT_ALLOWLIST);
}