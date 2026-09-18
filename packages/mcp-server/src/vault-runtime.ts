import type { ReconcileGate } from "./reconcile.js";
import type { PutObject } from "./txn.js";
import type { GetObject } from "./versions.js";
import type { VaultRegistry, VaultRegistryEntry } from "./vault-registry.js";
import { authorizeVaultSelection, type Principal, type VaultAuthFailure } from "./principal.js";

export interface VaultRuntime {
  readonly entry: VaultRegistryEntry;
  readonly gate: ReconcileGate;
  readonly putObject: PutObject;
  readonly getObject?: GetObject;
}

export interface VaultRequestContext {
  vaultId: string;
  vaultDir: string;
  entry: VaultRegistryEntry;
  gate: ReconcileGate;
  putObject: PutObject;
  getObject?: GetObject;
}

export function resolveVaultContext(input: {
  requested: string | undefined;
  principal: Principal;
  registry: VaultRegistry;
  runtimes: ReadonlyMap<string, VaultRuntime>;
}): { ok: true; ctx: VaultRequestContext } | VaultAuthFailure {
  const authorized = authorizeVaultSelection({
    requested: input.requested,
    principal: input.principal,
    registry: input.registry,
  });
  if (!authorized.ok) return authorized;
  const runtime = input.runtimes.get(authorized.vaultId);
  if (!runtime) {
    return { ok: false, error: "VAULT_UNKNOWN", message: `unknown vault: ${authorized.vaultId}` };
  }
  return {
    ok: true,
    ctx: {
      vaultId: runtime.entry.vaultId,
      vaultDir: runtime.entry.localRoot,
      entry: runtime.entry,
      gate: runtime.gate,
      putObject: runtime.putObject,
      getObject: runtime.getObject,
    },
  };
}
