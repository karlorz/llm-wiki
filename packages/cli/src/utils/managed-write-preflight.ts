import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { loadFleetManifestAndHost } from "../commands/fleet.js";
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
}

export interface ManagedWritePreflightInput {
  vault: string;
  command: string;
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

export async function runManagedWritePreflight(
  input: ManagedWritePreflightInput,
  deps: ManagedWritePreflightDeps = DEFAULT_DEPS,
): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }> {
  const vault = input.vault;
  const blocker = preflightBlocker(vault);
  if (blocker) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", {
        reason: blocker.reason,
        operation_id: blocker.operation_id,
        unmerged_paths: blocker.unmerged_paths,
      }),
    };
  }

  const fleet = await loadFleetManifestAndHost({
    vault,
    hostId: input.hostId,
    env: input.env as NodeJS.ProcessEnv | undefined,
    home: input.home,
    osHostname: input.osHostname,
  });

  if (!fleet) {
    const head = git(vault, ["rev-parse", "HEAD"]) || null;
    return {
      exitCode: ExitCode.OK,
      result: ok({
        mode: "standalone",
        base_oid: head,
        converged: false,
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
        base_oid: null,
        converged: false,
      }),
    };
  }

  const converge = await deps.converge({
    vault,
    lockToken: input.lockToken,
    env: input.env,
    home: input.home,
  });
  if (!converge.ok) {
    const exitCode =
      converge.error === "PREFLIGHT_FAILED" ? ExitCode.PREFLIGHT_FAILED : ExitCode.SYNC_PULL_FAILED;
    return { exitCode, result: converge };
  }

  const baseOid = git(vault, ["rev-parse", "HEAD"]);
  if (!baseOid) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", { reason: "missing-head-after-converge" }),
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
