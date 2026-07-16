import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { FLEET_REL_PATH, loadFleetManifestAndHost } from "../commands/fleet.js";
import { git } from "./git.js";
import {
  acquireManagedWriteLock,
  releaseManagedWriteLock,
  type ManagedWriteLockHandle,
} from "./managed-write-lock.js";
import {
  findReviewRequiredOp,
  hasActiveGitSequencer,
  hasUnmergedPaths,
  supersedeStaleReviewRequiredJournals,
} from "./operation-journal.js";
import {
  runVaultSyncPullHelper,
  type VaultSyncPullHelperInput,
  type VaultSyncPullReceipt,
} from "./vault-sync-helper.js";

export type ManagedWriteMode = "standalone" | "git-writer" | "immutable-record";

export interface ManagedWriteReceipt {
  mode: ManagedWriteMode;
  host_id?: string;
  base_oid: string | null;
  converged: boolean;
  helper_path?: string;
  /** Absolute path of the Git vault used for pull/base-OID when dual-path. */
  convergence_vault?: string;
}

export interface ManagedWritePreflightInput {
  vault: string;
  command: string;
  /**
   * Optional separate Git vault for pull, base-OID proof, and sequencer checks.
   * Mutation target remains `vault` (e.g. FUSE/S3 live path on sg01).
   */
  convergenceVault?: string;
  hostId?: string;
  lockToken?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  osHostname?: string;
  user?: string;
}

export interface ManagedWritePreflightDeps {
  converge(input: VaultSyncPullHelperInput): Promise<Result<VaultSyncPullReceipt>>;
}

export interface ManagedWriteTransactionInput<T> {
  vault: string;
  command: string;
  allowImmutableRecord: boolean;
  convergenceVault?: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  osHostname?: string;
  mutate(receipt: ManagedWriteReceipt): Promise<{ exitCode: number; result: Result<T> }>;
}

const DEFAULT_DEPS: ManagedWritePreflightDeps = {
  converge: (input) => runVaultSyncPullHelper(input),
};

function preflightBlocker(vault: string): { reason: string; operation_id?: string; unmerged_paths?: string[] } | null {
  const unmerged = hasUnmergedPaths(vault);
  if (unmerged.length > 0) {
    return {
      reason: "unmerged-paths",
      operation_id: findReviewRequiredOp(vault),
      unmerged_paths: unmerged,
    };
  }

  if (hasActiveGitSequencer(vault)) {
    return { reason: "git-operation-in-progress" };
  }

  // Auto-supersede historical handoff journals when the worktree is clean and targets are past.
  supersedeStaleReviewRequiredJournals(vault, { by: "skillwiki-managed-write-preflight" });

  const op = findReviewRequiredOp(vault);
  if (op) return { reason: "review-required", operation_id: op };
  return null;
}

function fleetManifestBytes(vault: string): Buffer | null {
  const path = join(vault, FLEET_REL_PATH);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

function isGitVault(vault: string): boolean {
  return Boolean(git(vault, ["rev-parse", "--absolute-git-dir"]));
}

export async function runManagedWritePreflight(
  input: ManagedWritePreflightInput,
  deps: ManagedWritePreflightDeps = DEFAULT_DEPS,
): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }> {
  const vault = input.vault;
  const convergenceVault =
    input.convergenceVault && resolve(input.convergenceVault) !== resolve(vault)
      ? resolve(input.convergenceVault)
      : undefined;
  const gitVault = convergenceVault ?? vault;

  // Mutation-target preflight: unmerged paths / review-required on the live vault.
  const mutationBlocker = preflightBlocker(vault);
  if (mutationBlocker) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", {
        reason: mutationBlocker.reason,
        operation_id: mutationBlocker.operation_id,
        unmerged_paths: mutationBlocker.unmerged_paths,
      }),
    };
  }

  // Git sequencer / review-required that belong to the convergence repository.
  if (convergenceVault) {
    if (!isGitVault(convergenceVault)) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "convergence-vault-not-git",
          convergence_vault: convergenceVault,
        }),
      };
    }
    const gitBlocker = preflightBlocker(convergenceVault);
    if (gitBlocker) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: gitBlocker.reason,
          operation_id: gitBlocker.operation_id,
          unmerged_paths: gitBlocker.unmerged_paths,
          convergence_vault: convergenceVault,
        }),
      };
    }

    // When either path carries a fleet manifest, both must present identical
    // bytes. Fixtures without fleet stay dual-path-capable (standalone mode).
    const targetFleet = fleetManifestBytes(vault);
    const convergeFleet = fleetManifestBytes(convergenceVault);
    if (targetFleet || convergeFleet) {
      if (!targetFleet || !convergeFleet || !targetFleet.equals(convergeFleet)) {
        return {
          exitCode: ExitCode.PREFLIGHT_FAILED,
          result: err("PREFLIGHT_FAILED", {
            reason: "convergence-vault-fleet-mismatch",
            detail:
              !targetFleet || !convergeFleet
                ? "fleet.yaml missing on mutation or convergence vault"
                : "fleet.yaml bytes differ between mutation and convergence vault",
            convergence_vault: convergenceVault,
          }),
        };
      }
    }
  }

  const fleet = await loadFleetManifestAndHost({
    vault,
    hostId: input.hostId,
    env: input.env as NodeJS.ProcessEnv | undefined,
    home: input.home,
    osHostname: input.osHostname,
  });

  if (!fleet) {
    const head = git(gitVault, ["rev-parse", "HEAD"]) || null;
    return {
      exitCode: ExitCode.OK,
      result: ok({
        mode: "standalone",
        base_oid: head,
        converged: false,
        ...(convergenceVault ? { convergence_vault: convergenceVault } : {}),
      }),
    };
  }

  if (fleet.identityStatus === "unknown" || fleet.identityStatus === "invalid" || !fleet.hostId) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", {
        reason: "fleet-identity-unresolved",
        identity_status: fleet.identityStatus,
        host_id: fleet.hostId,
      }),
    };
  }

  if (convergenceVault) {
    const convergeFleetCtx = await loadFleetManifestAndHost({
      vault: convergenceVault,
      hostId: input.hostId,
      env: input.env as NodeJS.ProcessEnv | undefined,
      home: input.home,
      osHostname: input.osHostname,
    });
    if (!convergeFleetCtx || convergeFleetCtx.hostId !== fleet.hostId) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "convergence-vault-identity-mismatch",
          host_id: fleet.hostId,
          convergence_host_id: convergeFleetCtx?.hostId,
          convergence_vault: convergenceVault,
        }),
      };
    }
  }

  const host = fleet.manifest.hosts[fleet.hostId];
  if (!host) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", { reason: "fleet-host-missing", host_id: fleet.hostId }),
    };
  }

  const writesGithub = host.writes_to.includes("github");
  if (!writesGithub) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        mode: "immutable-record",
        host_id: fleet.hostId,
        base_oid: null,
        converged: false,
        ...(convergenceVault ? { convergence_vault: convergenceVault } : {}),
      }),
    };
  }

  const converge = await deps.converge({
    vault: gitVault,
    lockToken: input.lockToken,
    env: input.env,
    home: input.home,
  });
  if (!converge.ok) {
    const exitCode =
      converge.error === "PREFLIGHT_FAILED" ? ExitCode.PREFLIGHT_FAILED : ExitCode.SYNC_PULL_FAILED;
    return { exitCode, result: converge };
  }

  const baseOid = git(gitVault, ["rev-parse", "HEAD"]);
  if (!baseOid) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", {
        reason: "missing-head-after-converge",
        ...(convergenceVault ? { convergence_vault: convergenceVault } : {}),
      }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      mode: "git-writer",
      host_id: fleet.hostId,
      base_oid: baseOid,
      converged: true,
      helper_path: converge.data.helper_path,
      ...(convergenceVault ? { convergence_vault: convergenceVault } : {}),
    }),
  };
}

export async function runManagedWriteTransaction<T>(
  input: ManagedWriteTransactionInput<T>,
  deps: ManagedWritePreflightDeps = DEFAULT_DEPS,
): Promise<{ exitCode: number; result: Result<T> }> {
  const lock = acquireManagedWriteLock(input.vault, input.command);
  if (!lock.ok) {
    return { exitCode: ExitCode.SYNC_LOCK_HELD, result: lock as Result<T> };
  }

  let handle: ManagedWriteLockHandle = lock.data;
  try {
    const preflight = await runManagedWritePreflight(
      {
        vault: input.vault,
        command: input.command,
        convergenceVault: input.convergenceVault,
        hostId: input.hostId,
        lockToken: handle.ownerToken,
        env: input.env,
        home: input.home,
        osHostname: input.osHostname,
      },
      deps,
    );
    if (!preflight.result.ok) {
      return { exitCode: preflight.exitCode, result: preflight.result as Result<T> };
    }
    const receipt = preflight.result.data;
    if (receipt.mode === "immutable-record" && !input.allowImmutableRecord) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "immutable-record-not-enabled",
          message: "Release A rejects immutable-record mode; event mode arrives in Release B",
          host_id: receipt.host_id,
        }) as Result<T>,
      };
    }
    return await input.mutate(receipt);
  } finally {
    releaseManagedWriteLock(handle);
  }
}
