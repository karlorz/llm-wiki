import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { FLEET_REL_PATH, loadFleetManifestAndHost } from "../commands/fleet.js";
import {
  runSyncPeers,
  MANAGED_WRITER_KINDS,
  STASH_AUDIT_CLASSIFICATIONS,
  STASH_AUDIT_FORMATS,
  type ManagedWriterObservation,
  type PeerLock,
  type StashAuditEntry,
  type SyncPeersInput,
  type SyncPeersOutput,
  type WikiSyncStash,
} from "../commands/sync.js";
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
  /** Test/host adapter for the pre-mutation peer observation. */
  syncPeers?(input: SyncPeersInput): { exitCode: number; result: Result<SyncPeersOutput> };
  /** Test/host adapter for sleep between peer polls. Defaults to setTimeout promise. */
  sleepMs?(ms: number): Promise<void>;
  /** Test/host adapter for wall clock. Defaults to Date.now. */
  nowMs?(): number;
  /** Test/host adapter for heartbeat logger. Defaults to writing to process.stderr. */
  logHeartbeat?(message: string): void;
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

/**
 * Default bounded wait time in milliseconds when a live writer (e.g. wiki-push)
 * is active during managed write preflight. Overridden by SKILLWIKI_MANAGED_WRITE_WAIT_MS.
 */
export const DEFAULT_MANAGED_WRITE_WAIT_MS = 240_000;

/**
 * Polling interval in milliseconds when waiting for live writer overlap to clear.
 */
export const MANAGED_WRITE_POLL_INTERVAL_MS = 2_000;

export function resolveManagedWriteWaitMs(env?: Record<string, string | undefined>): number {
  const raw = env?.SKILLWIKI_MANAGED_WRITE_WAIT_MS ?? process.env.SKILLWIKI_MANAGED_WRITE_WAIT_MS;
  if (!raw) return DEFAULT_MANAGED_WRITE_WAIT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MANAGED_WRITE_WAIT_MS;
  return parsed;
}

const DEFAULT_DEPS: ManagedWritePreflightDeps = {
  converge: (input) => runVaultSyncPullHelper(input),
  resolveConfiguredSnapshotWorktree,
  syncPeers: runSyncPeers,
  sleepMs: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMs: () => Date.now(),
  logHeartbeat: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
};

const SAFE_MANAGED_WRITER_KINDS = new Set<string>(MANAGED_WRITER_KINDS);
const SAFE_STASH_AUDIT_CLASSIFICATIONS = new Set<string>(STASH_AUDIT_CLASSIFICATIONS);
const SAFE_STASH_AUDIT_FORMATS = new Set<string>(STASH_AUDIT_FORMATS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPeerLock(value: unknown): value is PeerLock {
  if (!isRecord(value)) return false;
  return (
    typeof value.session_id === "string" &&
    isNonNegativeInteger(value.pid) &&
    typeof value.cwd === "string" &&
    typeof value.summary === "string" &&
    typeof value.acquired === "string" &&
    typeof value.expires === "string" &&
    typeof value.is_self === "boolean"
  );
}

function isWikiSyncStash(value: unknown): value is WikiSyncStash {
  if (!isRecord(value)) return false;
  return (
    typeof value.ref === "string" &&
    typeof value.oid === "string" &&
    typeof value.session_id === "string" &&
    typeof value.cwd_hash === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.summary === "string" &&
    isNonNegativeFiniteNumber(value.age_minutes)
  );
}

function isStashAuditEntry(value: unknown): value is StashAuditEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.ref !== "string" ||
    typeof value.oid !== "string" ||
    !isNonNegativeFiniteNumber(value.age_minutes) ||
    typeof value.classification !== "string" ||
    !SAFE_STASH_AUDIT_CLASSIFICATIONS.has(value.classification) ||
    typeof value.format !== "string" ||
    !SAFE_STASH_AUDIT_FORMATS.has(value.format)
  ) {
    return false;
  }
  if (value.session_id !== undefined && typeof value.session_id !== "string") return false;
  if (value.operation_id !== undefined && typeof value.operation_id !== "string") return false;
  return true;
}

function isManagedWriterObservation(value: unknown): value is ManagedWriterObservation {
  if (!isRecord(value) || !Array.isArray(value.kinds)) return false;
  if (
    !isNonNegativeInteger(value.count) ||
    typeof value.blocking !== "boolean" ||
    value.kinds.some(
      (kind) => typeof kind !== "string" || !SAFE_MANAGED_WRITER_KINDS.has(kind),
    )
  ) {
    return false;
  }
  if (value.blocking !== (value.count > 0)) return false;
  if (value.count === 0 && value.kinds.length > 0) return false;
  if (value.count > 0 && value.kinds.length === 0) return false;
  return true;
}

interface ValidatedSyncPeersOutput {
  output: SyncPeersOutput;
  foreignLockCount: number;
  recentPeerStashCount: number;
}

function validateSyncPeersOutput(value: unknown): ValidatedSyncPeersOutput | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.locks) ||
    !Array.isArray(value.stashes) ||
    !Array.isArray(value.stash_audit) ||
    typeof value.humanHint !== "string" ||
    typeof value.blocking !== "boolean" ||
    !isManagedWriterObservation(value.managed_writers)
  ) {
    return null;
  }
  let foreignLockCount = 0;
  for (const lock of value.locks) {
    if (!isPeerLock(lock)) return null;
    if (!lock.is_self) foreignLockCount += 1;
  }
  for (const stash of value.stashes) {
    if (!isWikiSyncStash(stash)) return null;
  }
  let recentPeerStashCount = 0;
  for (const entry of value.stash_audit) {
    if (!isStashAuditEntry(entry)) return null;
    if (entry.classification === "recent_known_peer_stash") recentPeerStashCount += 1;
  }
  return {
    output: value as unknown as SyncPeersOutput,
    foreignLockCount,
    recentPeerStashCount,
  };
}

function peerCheckFailure<T>(reason: string, detail: Record<string, unknown> = {}): {
  exitCode: number;
  result: Result<T>;
} {
  return {
    exitCode: ExitCode.PREFLIGHT_FAILED,
    result: err("PREFLIGHT_FAILED", { reason, ...detail }) as Result<T>,
  };
}

type PeerGateDecision<T> =
  | { status: "pass" }
  | {
      status: "overlap";
      count: number;
      kinds: string[];
      failure: { exitCode: number; result: Result<T> };
    }
  | {
      status: "block";
      failure: { exitCode: number; result: Result<T> };
    };

function evaluateManagedWritePeerGate<T>(
  vault: string,
  mode: ManagedWriteMode,
  deps: ManagedWritePreflightDeps,
): PeerGateDecision<T> {
  try {
    const check = (deps.syncPeers ?? DEFAULT_DEPS.syncPeers!)({ vault });
    if (check.exitCode !== ExitCode.OK || !check.result.ok) {
      return { status: "block", failure: peerCheckFailure<T>("peer-check-failed") };
    }
    const validated = validateSyncPeersOutput(check.result.data);
    if (!validated) {
      return { status: "block", failure: peerCheckFailure<T>("peer-check-failed") };
    }

    const { output: peerOutput, foreignLockCount, recentPeerStashCount } = validated;
    const nonWriterBlockingSignal = foreignLockCount > 0 || recentPeerStashCount > 0;
    const writerOnly = peerOutput.managed_writers.blocking && !nonWriterBlockingSignal;
    // Process snapshots are machine-wide, so they are meaningful only for a
    // fleet-managed Git writer. Locks and stash audits remain vault-scoped.
    if (mode !== "git-writer" && writerOnly) return { status: "pass" };

    const managedWriterBlocking = mode === "git-writer" && peerOutput.managed_writers.blocking;
    const hasKnownBlockingSignal =
      foreignLockCount > 0 ||
      managedWriterBlocking ||
      recentPeerStashCount > 0;
    if (!peerOutput.blocking) {
      return hasKnownBlockingSignal
        ? { status: "block", failure: peerCheckFailure<T>("peer-check-failed") }
        : { status: "pass" };
    }

    if (managedWriterBlocking) {
      const kinds = peerOutput.managed_writers.kinds.slice(0, 8);
      return {
        status: "overlap",
        count: peerOutput.managed_writers.count,
        kinds,
        failure: peerCheckFailure<T>("live-writer-overlap", {
          managed_writer_count: peerOutput.managed_writers.count,
          managed_writer_kinds: kinds,
          blocking: true,
        }),
      };
    }

    if (foreignLockCount > 0) {
      return {
        status: "block",
        failure: peerCheckFailure<T>("peer-lock", {
          foreign_lock_count: foreignLockCount,
          blocking: true,
        }),
      };
    }

    if (recentPeerStashCount > 0) {
      return {
        status: "block",
        failure: peerCheckFailure<T>("recent-peer-stash", {
          recent_peer_stash_count: recentPeerStashCount,
          stash_classification: "recent_known_peer_stash",
          blocking: true,
        }),
      };
    }

    return {
      status: "block",
      failure: peerCheckFailure<T>("peer-blocked", { blocking: true }),
    };
  } catch {
    return { status: "block", failure: peerCheckFailure<T>("peer-check-failed") };
  }
}

export async function runManagedWritePeerGate<T>(
  vault: string,
  mode: ManagedWriteMode,
  deps: ManagedWritePreflightDeps = DEFAULT_DEPS,
  env?: Record<string, string | undefined>,
): Promise<{ exitCode: number; result: Result<T> } | null> {
  const now = deps.nowMs ?? DEFAULT_DEPS.nowMs!;
  const sleep = deps.sleepMs ?? DEFAULT_DEPS.sleepMs!;
  const logHeartbeat = deps.logHeartbeat ?? DEFAULT_DEPS.logHeartbeat!;
  const waitMs = resolveManagedWriteWaitMs(env);

  const initial = evaluateManagedWritePeerGate<T>(vault, mode, deps);
  if (initial.status === "pass") return null;
  if (initial.status === "block") return initial.failure;

  // status === "overlap": live-writer-overlap detected. Bounded wait-and-retry.
  const startedAt = now();
  const deadline = startedAt + waitMs;
  let lastOverlap = initial;

  for (;;) {
    const elapsed = Math.max(0, now() - startedAt);
    const remainingMs = Math.max(0, deadline - now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const writerKindDesc = lastOverlap.kinds.length > 0 ? lastOverlap.kinds.join(", ") : "unknown";
    logHeartbeat(`skillwiki: waiting for live vault writer (${writerKindDesc}), ${remainingSec}s left`);

    if (now() >= deadline) {
      return peerCheckFailure<T>("live-writer-overlap", {
        managed_writer_count: lastOverlap.count,
        managed_writer_kinds: lastOverlap.kinds,
        blocking: true,
        waited_ms: elapsed,
      });
    }

    const nextSleepMs = Math.min(MANAGED_WRITE_POLL_INTERVAL_MS, remainingMs);
    await sleep(nextSleepMs);

    const check = evaluateManagedWritePeerGate<T>(vault, mode, deps);
    if (check.status === "pass") return null;
    if (check.status === "block") return check.failure;
    lastOverlap = check;
  }
}

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
    // fleet.yaml present but unreadable/unparseable must fail closed; only a
    // truly absent fleet means standalone.
    if (hasFleetManifest(mutationVault)) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", { reason: "fleet-unreadable" }),
      };
    }
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
        ...(convergenceVault ? { convergence_vault: convergenceVault } : {}),
        convergence_source: convergenceSource,
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
  const lock = acquireManagedWriteLock(mutationVault, input.command, {
    gitStateVault: input.convergenceVault
      ? resolve(input.convergenceVault)
      : mutationVault,
  });
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
    const peerGate = await runManagedWritePeerGate<T>(mutationVault, receipt.mode, deps, input.env);
    if (peerGate) return peerGate;
    return await input.mutate(receipt);
  } finally {
    releaseManagedWriteLock(handle);
  }
}
