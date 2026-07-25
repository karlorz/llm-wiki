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
import { resolveConfiguredSnapshotWorktree } from "./snapshot-worktree.js";

export type ManagedWriteMode = "standalone" | "git-writer" | "immutable-record";
export type ManagedWriteConvergenceSource = "single-path" | "explicit" | "configured";

export interface ManagedWriteReceipt {
  mode: ManagedWriteMode;
  host_id?: string;
  /** Absolute live vault where the mutation callback is allowed to write. */
  mutation_vault: string;
  /** Absolute Git vault used for HEAD/base-OID proof, or null for record-only writes. */
  git_vault: string | null;
  base_oid: string | null;
  converged: boolean;
  helper_path?: string;
  /** Absolute path of the Git vault used for pull/base-OID when dual-path. */
  convergence_vault?: string;
  convergence_source: ManagedWriteConvergenceSource;
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
  resolveConfiguredSnapshotWorktree?(home: string): string | undefined;
}

export interface ManagedWriteTransactionInput<T> {
  vault: string;
  command: string;
  allowImmutableRecord: boolean;
  convergenceVault?: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  osHostname?: string;
  user?: string;
  preflight?(
    input: ManagedWritePreflightInput,
  ): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }>;
  mutate(receipt: ManagedWriteReceipt): Promise<{ exitCode: number; result: Result<T> }>;
}

const DEFAULT_DEPS: ManagedWritePreflightDeps = {
  converge: (input) => runVaultSyncPullHelper(input),
  resolveConfiguredSnapshotWorktree,
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

  // target_oid ancestry proves the handoff is obsolete. Preserve unrelated dirty
  // WIP; active sequencers and unmerged paths already failed closed above.
  supersedeStaleReviewRequiredJournals(vault, {
    by: "skillwiki-managed-write-preflight",
    requireClean: false,
  });

  const op = findReviewRequiredOp(vault);
  if (op) return { reason: "review-required", operation_id: op };
  return null;
}

function hasFleetManifest(vault: string): boolean {
  return existsSync(join(vault, FLEET_REL_PATH));
}

function isGitVault(vault: string): boolean {
  return Boolean(git(vault, ["rev-parse", "--absolute-git-dir"]));
}

export async function runManagedWritePreflight(
  input: ManagedWritePreflightInput,
  deps: ManagedWritePreflightDeps = DEFAULT_DEPS,
): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }> {
  const mutationVault = resolve(input.vault);
  let convergenceVault =
    input.convergenceVault && resolve(input.convergenceVault) !== mutationVault
      ? resolve(input.convergenceVault)
      : undefined;
  let convergenceSource: ManagedWriteConvergenceSource =
    convergenceVault ? "explicit" : "single-path";

  // Mutation-target preflight: unmerged paths / review-required on the live vault.
  const mutationBlocker = preflightBlocker(mutationVault);
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

  // Fleet identity and write authority always come from the mutation target.
  const fleet = await loadFleetManifestAndHost({
    vault: mutationVault,
    hostId: input.hostId,
    env: input.env as NodeJS.ProcessEnv | undefined,
    home: input.home,
    cwd: input.cwd,
    osHostname: input.osHostname,
    user: input.user,
  });

  if (!fleet) {
    const gitVault = isGitVault(mutationVault) ? mutationVault : null;
    const head = gitVault ? git(gitVault, ["rev-parse", "HEAD"]) || null : null;
    return {
      exitCode: ExitCode.OK,
      result: ok({
        mode: "standalone",
        mutation_vault: mutationVault,
        git_vault: gitVault,
        base_oid: head,
        converged: false,
        convergence_source: "single-path",
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
        mutation_vault: mutationVault,
        git_vault: null,
        base_oid: null,
        converged: false,
        ...(convergenceVault ? { convergence_vault: convergenceVault } : {}),
        convergence_source: convergenceSource,
      }),
    };
  }

  if (!convergenceVault && host.role === "snapshotter" && host.protected === true) {
    const home = input.home ?? input.env?.HOME ?? process.env.HOME ?? "";
    const configured =
      (deps.resolveConfiguredSnapshotWorktree ?? resolveConfiguredSnapshotWorktree)(home);
    if (!configured) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "convergence-vault-not-configured",
          host_id: fleet.hostId,
          mutation_vault: mutationVault,
        }),
      };
    }
    convergenceVault = resolve(configured);
    convergenceSource = "configured";
    if (convergenceVault === mutationVault) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "convergence-vault-not-distinct",
          host_id: fleet.hostId,
          mutation_vault: mutationVault,
          convergence_vault: convergenceVault,
        }),
      };
    }
  }

  const gitVault = convergenceVault ?? mutationVault;

  // Git sequencer / review-required that belong to the convergence repository.
  // Do not require pre-pull fleet.yaml byte equality: snapshot deliberately
  // reconciles S3↔Git drift, and fleet files can differ until rclone runs.
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
    const convergenceHasFleet = hasFleetManifest(convergenceVault);
    if (convergenceSource === "configured" && !convergenceHasFleet) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "convergence-vault-fleet-missing",
          host_id: fleet.hostId,
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
  }

  // When the convergence vault also carries a fleet, require the same resolved
  // host id (not full-file byte equality) so dual-path cannot pair a leaf
  // identity with a snapshotter mutation target.
  if (convergenceVault && hasFleetManifest(convergenceVault)) {
    const convergeFleetCtx = await loadFleetManifestAndHost({
      vault: convergenceVault,
      hostId: input.hostId ?? fleet.hostId,
      env: input.env as NodeJS.ProcessEnv | undefined,
      home: input.home,
      cwd: input.cwd,
      osHostname: input.osHostname,
      user: input.user,
    });
    if (
      !convergeFleetCtx ||
      convergeFleetCtx.identityStatus !== "known" ||
      convergeFleetCtx.hostId !== fleet.hostId
    ) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "convergence-vault-identity-mismatch",
          host_id: fleet.hostId,
          convergence_host_id: convergeFleetCtx?.hostId,
          convergence_identity_status: convergeFleetCtx?.identityStatus,
          convergence_vault: convergenceVault,
        }),
      };
    }
  }

  const dualPathMeta = convergenceVault ? { convergence_vault: convergenceVault } : {};

  // Dual-path: mutation lock lives on the live vault (often non-Git FUSE);
  // the pull helper locks the Git convergence vault separately. Passing the
  // mutation lock token would make the helper look for the same token under
  // the Git lock path and fail closed with a false "lock held".
  const converge = await deps.converge({
    vault: gitVault,
    lockToken: convergenceVault ? undefined : input.lockToken,
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
        ...dualPathMeta,
      }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      mode: "git-writer",
      host_id: fleet.hostId,
      mutation_vault: mutationVault,
      git_vault: gitVault,
      base_oid: baseOid,
      converged: true,
      helper_path: converge.data.helper_path,
      ...dualPathMeta,
      convergence_source: convergenceSource,
    }),
  };
}

export async function runManagedWriteTransaction<T>(
  input: ManagedWriteTransactionInput<T>,
  deps: ManagedWritePreflightDeps = DEFAULT_DEPS,
): Promise<{ exitCode: number; result: Result<T> }> {
  const mutationVault = resolve(input.vault);
  const lock = acquireManagedWriteLock(mutationVault, input.command);
  if (!lock.ok) {
    return { exitCode: ExitCode.SYNC_LOCK_HELD, result: lock as Result<T> };
  }

  const handle: ManagedWriteLockHandle = lock.data;
  try {
    const preflightInput: ManagedWritePreflightInput = {
      vault: mutationVault,
      command: input.command,
      convergenceVault: input.convergenceVault,
      hostId: input.hostId,
      lockToken: handle.ownerToken,
      env: input.env,
      home: input.home,
      cwd: input.cwd,
      osHostname: input.osHostname,
      user: input.user,
    };
    const preflight = input.preflight
      ? await input.preflight(preflightInput)
      : await runManagedWritePreflight(preflightInput, deps);
    if (!preflight.result.ok) {
      return { exitCode: preflight.exitCode, result: preflight.result as Result<T> };
    }
    const receipt = preflight.result.data;
    if (receipt.mutation_vault !== mutationVault) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "mutation-vault-receipt-mismatch",
          expected: mutationVault,
          actual: receipt.mutation_vault,
        }) as Result<T>,
      };
    }
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
