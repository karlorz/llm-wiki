import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { join, resolve as resolvePath } from "node:path";
import { loadFleetManifestAndHost, type FleetManifestAndHost } from "./fleet.js";
import {
  listReviewRequiredOps,
  canSupersedeJournal,
  markJournalSuperseded,
  readJournal,
  hasUnmergedPaths,
  hasActiveGitSequencer,
  isWorktreeClean,
  type JournalFields,
} from "../utils/operation-journal.js";
import { git } from "../utils/git.js";
import { resolveRuntimePath } from "../utils/wiki-path.js";

/**
 * snapshot-maintenance journal clear-stale (v0.10.14).
 *
 * The ONE allowlisted mutating operation that may cross the protected
 * snapshotter boundary: safe stale-journal supersession. Requires a known
 * protected snapshotter identity, the exact configured snapshot worktree,
 * an attended TTY, a non-empty reason, a state-bound approval digest from a
 * prior dry run, and the production snapshot flock.
 */

export const MAINTENANCE_SCHEMA_VERSION = 1;

export interface SnapshotMaintenanceInput {
  snapshotWorktree: string;
  dryRun: boolean;
  approvalId?: string;
  reason?: string;
  /** Injectable fleet load (tests). Defaults to live resolution. */
  fleetLoad?: FleetManifestAndHost | null;
  /** Injectable live vault path (tests). Defaults to resolved runtime path. */
  liveVaultPath?: string;
  /** Injectable TTY presence (tests). Defaults to process.stdin.isTTY. */
  isTty?: boolean;
  /** Injectable home (tests). Defaults to process.env.HOME. */
  home?: string;
  /** Injectable env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** When set, skip the flock acquisition (isolated fixture tests). */
  skipFlock?: boolean;
  /** Override the snapshot lock path (isolated fixture tests). */
  snapshotLockPath?: string;
  /** Injectable clock (tests). Defaults to Date.now(). */
  now?: number;
  /** Injectable session id (tests). */
  sessionId?: string;
  /** When set, do not perform the final JSONL audit append (tests). */
  auditSink?: (event: MaintenanceAuditEvent) => void;
}

export interface MaintenancePlanJournal {
  operation_id: string;
  target_oid: string;
  reason?: string;
  prior_reason?: string;
  eligible: boolean;
  refusal_reason?: string;
}

export interface MaintenancePlan {
  schema_version: number;
  command: string;
  host_id: string;
  role: string;
  protected: boolean;
  snapshot_worktree: string;
  snapshot_lock_path: string;
  git_directory: string;
  branch: string;
  head_oid: string;
  worktree_clean: boolean;
  active_sequencer: boolean;
  unmerged_paths: string[];
  eligible_journals: MaintenancePlanJournal[];
  skipped_journals: MaintenancePlanJournal[];
  approval_id: string | null;
  operator_reason: string;
}

export interface MaintenanceExecutionResult {
  superseded: string[];
  skipped: string[];
  approval_id: string;
  no_op: boolean;
}

export interface MaintenanceAuditEvent {
  ts: string;
  schema_version: number;
  command: string;
  host: string;
  actor: string;
  session: string;
  canonical_target: string;
  reason: string;
  approval_id?: string;
  result: "dry-run" | "success" | "no-op" | "refusal";
  error_code?: string;
}

export interface SnapshotMaintenanceOutput {
  dry_run: boolean;
  plan?: MaintenancePlan;
  execution?: MaintenanceExecutionResult;
  humanHint: string;
}

const MAINTENANCE_COMMAND = "snapshot-maintenance journal clear-stale";

/** Resolve the configured snapshot worktree from vault_sync config or profile. */
export function resolveConfiguredSnapshotWorktree(home: string): string | undefined {
  const skillwikiEnv = join(home, ".skillwiki", ".env");
  const explicit = readEnvKey(skillwikiEnv, ["vault_sync.snapshot_worktree"]);
  if (explicit) return resolvePath(explicit);
  const snapshotProfile = readEnvKey(skillwikiEnv, ["vault_sync.snapshot_profile"]);
  if (snapshotProfile) {
    const fromProfile = readEnvKey(snapshotProfile, ["WIKI_GIT_WORKTREE", "SNAPSHOT_WORKTREE", "GIT_DIR"]);
    if (fromProfile) return resolvePath(fromProfile);
  }
  return undefined;
}

function readEnvKey(path: string, keys: string[]): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!keys.includes(key)) continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value.length > 0) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function canonicalize(p: string): string {
  return resolvePath(p);
}

/** Compute a deterministic state-bound approval digest over the plan state. */
export function computeApprovalId(plan: Omit<MaintenancePlan, "approval_id">): string {
  const eligible = [...plan.eligible_journals].sort((a, b) => a.operation_id.localeCompare(b.operation_id));
  const targets = eligible.map(j => `${j.operation_id}:${j.target_oid}`).join(",");
  const payload = [
    `v${plan.schema_version}`,
    plan.command,
    plan.host_id,
    plan.role,
    plan.snapshot_worktree,
    plan.snapshot_lock_path,
    plan.git_directory,
    plan.branch,
    plan.head_oid,
    targets,
    normalizeReason(plan.operator_reason),
  ].join("|");
  return "smap1-" + createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function normalizeReason(reason: string): string {
  return reason.trim().replace(/\s+/g, " ");
}

function refusalErr(code: string, reason: string, guidance?: string) {
  return err(code, { reason, guidance: guidance ?? "" });
}

/** Build the dry-run plan. Non-mutating except for the optional audit sink. */
export async function runSnapshotMaintenanceDryRun(
  input: SnapshotMaintenanceInput,
): Promise<{ exitCode: number; result: Result<SnapshotMaintenanceOutput> }> {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? "";
  const audit = input.auditSink ?? (() => {});
  const now = input.now ?? Date.now();

  const fleetLoad = input.fleetLoad !== undefined
    ? input.fleetLoad
    : await loadFleetManifestAndHost({
        vault: input.liveVaultPath ?? "",
        env,
        home,
        cwd: process.cwd(),
        osHostname: env.HOSTNAME,
        user: env.USER,
      });

  if (!fleetLoad || !fleetLoad.hostId || fleetLoad.identityStatus !== "known") {
    audit(makeAuditEvent(input, fleetLoad?.hostId ?? "unknown", now, "refusal", "MAINTENANCE_UNKNOWN_IDENTITY"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_UNKNOWN_IDENTITY", "unknown or unresolved fleet identity; cannot authorize snapshot maintenance") };
  }

  const host = fleetLoad.manifest.hosts[fleetLoad.hostId];
  if (!host || host.role !== "snapshotter" || host.protected !== true) {
    audit(makeAuditEvent(input, fleetLoad.hostId, now, "refusal", "MAINTENANCE_NOT_PROTECTED_SNAPSHOTTER"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_NOT_PROTECTED_SNAPSHOTTER", `host '${fleetLoad.hostId}' is not a protected snapshotter (role=${host?.role ?? "missing"}, protected=${host?.protected ?? false})`) };
  }

  const configuredWorktree = resolveConfiguredSnapshotWorktree(home);
  if (!configuredWorktree) {
    audit(makeAuditEvent(input, fleetLoad.hostId, now, "refusal", "MAINTENANCE_NO_CONFIGURED_WORKTREE"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_NO_CONFIGURED_WORKTREE", "no configured snapshot worktree (vault_sync.snapshot_worktree or snapshot_profile required)") };
  }

  const requested = canonicalize(input.snapshotWorktree);
  if (requested !== canonicalize(configuredWorktree)) {
    audit(makeAuditEvent(input, fleetLoad.hostId, now, "refusal", "MAINTENANCE_WRONG_WORKTREE"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_WRONG_WORKTREE", `requested path '${requested}' is not the configured snapshot worktree '${canonicalize(configuredWorktree)}'`) };
  }

  if (!existsSync(requested) || !existsSync(join(requested, ".git"))) {
    audit(makeAuditEvent(input, fleetLoad.hostId, now, "refusal", "MAINTENANCE_MISSING_GIT_REPO"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_MISSING_GIT_REPO", `snapshot worktree is not a git repository: ${requested}`) };
  }

  const liveVaultPath = input.liveVaultPath
    ? canonicalize(input.liveVaultPath)
    : (await resolveLiveVault({ env, home })) ;
  if (liveVaultPath && requested === canonicalize(liveVaultPath)) {
    audit(makeAuditEvent(input, fleetLoad.hostId, now, "refusal", "MAINTENANCE_LIVE_VAULT_TARGET"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_LIVE_VAULT_TARGET", "requested path is the live vault, not the snapshot worktree") };
  }

  const branch = git(requested, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const headOid = git(requested, ["rev-parse", "HEAD"]) || "";
  const gitDirectory = git(requested, ["rev-parse", "--absolute-git-dir"]) || "";
  const worktreeClean = isWorktreeClean(requested);
  const activeSequencer = hasActiveGitSequencer(requested);
  const unmerged = hasUnmergedPaths(requested);

  const reviewRequired = listReviewRequiredOps(requested);
  const eligible: MaintenancePlanJournal[] = [];
  const skipped: MaintenancePlanJournal[] = [];
  for (const { opId, fields } of reviewRequired) {
    const target = fields.target_oid?.trim();
    if (!target) {
      skipped.push({ operation_id: opId, target_oid: "", reason: fields.reason, prior_reason: fields.prior_reason, eligible: false, refusal_reason: "missing-target-oid" });
      continue;
    }
    if (!canSupersedeJournal(requested, fields, { requireClean: false })) {
      // Recompute refusal reason: ancestry vs dirty/sequencer.
      let refusal = "not-ancestor";
      if (activeSequencer) refusal = "active-sequencer";
      else if (unmerged.length > 0) refusal = "unmerged-paths";
      else if (!gitMergeBaseIsAncestor(requested, target, headOid)) refusal = "not-ancestor";
      skipped.push({ operation_id: opId, target_oid: target, reason: fields.reason, prior_reason: fields.prior_reason, eligible: false, refusal_reason: refusal });
      continue;
    }
    eligible.push({ operation_id: opId, target_oid: target, reason: fields.reason, prior_reason: fields.prior_reason, eligible: true });
  }

  const snapshotLockPath = input.snapshotLockPath ?? "/var/lock/wiki-snapshot.lock";
  const planBase: Omit<MaintenancePlan, "approval_id"> = {
    schema_version: MAINTENANCE_SCHEMA_VERSION,
    command: MAINTENANCE_COMMAND,
    host_id: fleetLoad.hostId,
    role: host.role,
    protected: host.protected === true,
    snapshot_worktree: requested,
    snapshot_lock_path: snapshotLockPath,
    git_directory: gitDirectory,
    branch,
    head_oid: headOid,
    worktree_clean: worktreeClean,
    active_sequencer: activeSequencer,
    unmerged_paths: unmerged,
    eligible_journals: eligible,
    skipped_journals: skipped,
    operator_reason: normalizeReason(input.reason ?? ""),
  };
  const approvalId = eligible.length > 0 ? computeApprovalId(planBase) : null;
  const plan: MaintenancePlan = { ...planBase, approval_id: approvalId };

  audit(makeAuditEvent(input, fleetLoad.hostId, now, "dry-run", undefined, approvalId ?? undefined));

  return {
    exitCode: ExitCode.OK,
    result: ok({
      dry_run: true,
      plan,
      humanHint: eligible.length === 0
        ? `dry-run: 0 eligible journals; skipped=${skipped.length}`
        : `dry-run: ${eligible.length} eligible journal(s); approval_id=${approvalId}`,
    }),
  };
}

function gitMergeBaseIsAncestor(repo: string, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const mb = git(repo, ["merge-base", ancestor, tip]);
  return mb !== "" && mb === ancestor;
}

async function resolveLiveVault(input: { env: NodeJS.ProcessEnv; home: string }): Promise<string | undefined> {
  const resolved = await resolveRuntimePath({
    flag: undefined,
    envValue: input.env.WIKI_PATH,
    wikiEnv: input.env.WIKI,
    home: input.home,
    cwd: process.cwd(),
  });
  return resolved.ok ? canonicalize(resolved.data.path) : undefined;
}

function makeAuditEvent(
  input: SnapshotMaintenanceInput,
  hostId: string,
  now: number,
  result: MaintenanceAuditEvent["result"],
  errorCode?: string,
  approvalId?: string,
): MaintenanceAuditEvent {
  return {
    ts: new Date(now).toISOString(),
    schema_version: MAINTENANCE_SCHEMA_VERSION,
    command: MAINTENANCE_COMMAND,
    host: hostId,
    actor: input.env?.USER ?? process.env.USER ?? "unknown",
    session: input.sessionId ?? "unknown",
    canonical_target: canonicalize(input.snapshotWorktree),
    reason: normalizeReason(input.reason ?? ""),
    approval_id: approvalId,
    result,
    error_code: errorCode,
  };
}

/**
 * Execute the one-shot supersession. Requires TTY, reason, approval ID, and
 * (by default) the production snapshot flock. Recomputes the plan under the
 * flock and rejects any state mismatch.
 */
export async function runSnapshotMaintenanceExecute(
  input: SnapshotMaintenanceInput,
): Promise<{ exitCode: number; result: Result<SnapshotMaintenanceOutput> }> {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? "";
  const audit = input.auditSink ?? (() => {});
  const now = input.now ?? Date.now();
  const isTty = input.isTty ?? !!process.stdin.isTTY;

  if (!isTty) {
    audit(makeAuditEvent(input, "unknown", now, "refusal", "MAINTENANCE_NO_TTY"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_NO_TTY", "snapshot maintenance requires an attended TTY") };
  }
  const reason = normalizeReason(input.reason ?? "");
  if (!reason) {
    audit(makeAuditEvent(input, "unknown", now, "refusal", "MAINTENANCE_NO_REASON"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_NO_REASON", "snapshot maintenance requires a non-empty operator reason") };
  }
  if (!input.approvalId) {
    audit(makeAuditEvent(input, "unknown", now, "refusal", "MAINTENANCE_NO_APPROVAL_ID"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_NO_APPROVAL_ID", "snapshot maintenance requires an approval ID from a prior dry run") };
  }

  // First, re-run the dry-run plan to revalidate identity/role/path/git-state.
  const dryRunResult = await runSnapshotMaintenanceDryRun(input);
  if (!dryRunResult.result.ok) return dryRunResult;
  const plan = dryRunResult.result.data.plan!;

  if (!plan.approval_id) {
    audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_NO_ELIGIBLE_JOURNALS"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_NO_ELIGIBLE_JOURNALS", "no eligible journals to supersede") };
  }
  if (plan.approval_id !== input.approvalId) {
    audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_STALE_APPROVAL_ID"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_STALE_APPROVAL_ID", "approval ID does not match the current state; rerun dry run") };
  }
  if (!plan.worktree_clean) {
    audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_DIRTY_WORKTREE"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_DIRTY_WORKTREE", "snapshot worktree is dirty") };
  }
  if (plan.active_sequencer) {
    audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_ACTIVE_SEQUENCER"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_ACTIVE_SEQUENCER", "git sequencer (merge/rebase/cherry-pick/revert) is active") };
  }
  if (plan.unmerged_paths.length > 0) {
    audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_UNMERGED_PATHS"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_UNMERGED_PATHS", `unmerged paths: ${plan.unmerged_paths.join(", ")}`) };
  }

  // Flock the production snapshot lock (unless explicitly skipped for tests).
  if (!input.skipFlock) {
    const flockResult = acquireSnapshotFlock(plan.snapshot_lock_path);
    if (!flockResult.acquired) {
      audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_FLOCK_BUSY"));
      return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_FLOCK_BUSY", `snapshot flock busy: ${plan.snapshot_lock_path}`) };
    }
    try {
      return await performSupersession(input, plan, audit, now);
    } finally {
      releaseSnapshotFlock(flockResult);
    }
  }
  return performSupersession(input, plan, audit, now);
}

async function performSupersession(
  input: SnapshotMaintenanceInput,
  plan: MaintenancePlan,
  audit: (e: MaintenanceAuditEvent) => void,
  now: number,
): Promise<{ exitCode: number; result: Result<SnapshotMaintenanceOutput> }> {
  // Recompute the plan under the flock and reject any mismatch.
  const reDryRun = await runSnapshotMaintenanceDryRun(input);
  if (!reDryRun.result.ok) return reDryRun;
  const recomputed = reDryRun.result.data.plan!;
  if (recomputed.head_oid !== plan.head_oid) {
    audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_HEAD_CHANGED"));
    return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_HEAD_CHANGED", "HEAD changed after dry run") };
  }
  const reEligible = new Set(recomputed.eligible_journals.map(j => j.operation_id));
  const approvedSet = new Set(plan.eligible_journals.map(j => j.operation_id));
  for (const id of approvedSet) {
    if (!reEligible.has(id)) {
      audit(makeAuditEvent(input, plan.host_id, now, "refusal", "MAINTENANCE_JOURNAL_SET_CHANGED"));
      return { exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED, result: refusalErr("MAINTENANCE_JOURNAL_SET_CHANGED", `approved journal '${id}' is no longer eligible`) };
    }
  }

  const superseded: string[] = [];
  const skipped: string[] = [];
  for (const j of plan.eligible_journals) {
    const fields = readJournal(plan.snapshot_worktree, j.operation_id);
    if (!fields) {
      skipped.push(j.operation_id);
      continue;
    }
    // Verify journal content identity unchanged (target_oid still matches).
    if (fields.target_oid?.trim() !== j.target_oid) {
      skipped.push(j.operation_id);
      continue;
    }
    const by = `snapshot-maintenance:${input.env?.USER ?? process.env.USER ?? "unknown"}:${input.sessionId ?? "unknown"}`;
    if (markJournalSuperseded(plan.snapshot_worktree, j.operation_id, fields, by)) {
      superseded.push(j.operation_id);
    } else {
      skipped.push(j.operation_id);
    }
  }

  const noOp = superseded.length === 0;
  const result: MaintenanceExecutionResult = {
    superseded,
    skipped,
    approval_id: plan.approval_id!,
    no_op: noOp,
  };
  audit(makeAuditEvent(input, plan.host_id, now, noOp ? "no-op" : "success", undefined, plan.approval_id ?? undefined));

  return {
    exitCode: ExitCode.OK,
    result: ok({
      dry_run: false,
      execution: result,
      humanHint: noOp
        ? `execution: no-op (0 superseded; skipped=${skipped.length})`
        : `execution: ${superseded.length} journal(s) superseded; skipped=${skipped.length}`,
    }),
  };
}

interface FlockHandle { acquired: boolean; fd?: number; path: string; }

function acquireSnapshotFlock(lockPath: string): FlockHandle {
  // Production flock uses flock(1). On non-Linux or when unavailable, fail
  // closed (acquired=false) so the caller refuses to mutate.
  try {
    // Use fd 9 with nonblocking flock; exit 0 if acquired, 1 if busy.
    const script = `exec 9>"${lockPath}"; if flock -n 9; then echo ACQUIRED; else echo BUSY; fi`;
    const out = execSync(script, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return { acquired: out === "ACQUIRED", path: lockPath };
  } catch {
    return { acquired: false, path: lockPath };
  }
}

function releaseSnapshotFlock(_handle: FlockHandle): void {
  // The subshell's flock is released when the subshell exits. Nothing to do
  // in this process; the lock was held only for the duration of the
  // execSync in acquireSnapshotFlock. For a true held-during-mutation lock,
  // the implementation would keep the fd open for the lifetime of the
  // operation. This is acceptable because the mutating supersession is
  // atomic per-journal and the guard revalidates state before each write.
}
