import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { git } from "../utils/git.js";
import { listReviewRequiredOps } from "../utils/operation-journal.js";
import {
  probeS3Reachability,
  resolveWikiS3Remote,
  REMOTE_PROBE_TIMEOUT_MS,
} from "../utils/remote-health.js";
import { countEventLedgerFiles, measureDirtyVolume } from "../utils/vault-write-gates.js";
import { inspectConfiguredFetchProjection } from "../utils/fetch-projection.js";
import { measureAuthoritativeLiveDrift } from "../utils/live-drift.js";
import {
  runCopyStatus as runCopyStatusCore,
  type CopyStatus,
  type CopyStatusDeps,
} from "../copy-status/copy-status.js";

export interface CopyStatusInput {
  vault: string;
  home: string;
  s3Ok?: boolean;
  deps?: CopyStatusDeps;
}

export type CopyStatusOutput = CopyStatus;

function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathsAreNested(left: string, right: string): boolean {
  const rel = relative(comparablePath(left), comparablePath(right));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function defaultCopyStatusDeps(input: CopyStatusInput): CopyStatusDeps {
  const selection = inspectConfiguredFetchProjection(input.home);
  const sameAsLive = selection.path !== undefined && comparablePath(selection.path) === comparablePath(input.vault);
  const nestedWithLive = selection.path !== undefined
    && (pathsAreNested(selection.path, input.vault) || pathsAreNested(input.vault, selection.path));
  const configuredProjection = sameAsLive || nestedWithLive ? undefined : selection.path;
  const projectionProblem = selection.invalidDetail
    ?? (sameAsLive
      ? "configured fetch projection must be distinct from live vault"
      : nestedWithLive
        ? "configured fetch projection and live vault must not be nested"
        : undefined);
  const gitVault = input.vault;
  const projectionWarning = selection.configured
    ? `configured fetch projection ignored for Git status; using live vault${projectionProblem ? ` (${projectionProblem})` : ""}`
    : undefined;
  const invalidProjectionDetail = projectionProblem ?? "configured fetch projection is not a git repository";
  const gitRootProblem = (): string | undefined => {
    if (!existsSync(join(gitVault, ".git"))) {
      return "vault is not a git repository";
    }
    return undefined;
  };
  return {
    probeLive() {
      if (input.s3Ok === true) return { reachable: true, detail: "MCP S3 ok" };
      if (input.s3Ok === false) return { reachable: false, detail: "MCP S3 not ok" };
      const remote = resolveWikiS3Remote({ home: input.home });
      if (!remote) {
        return { unknown: true, detail: "Git worktree is not the live plane; S3 remote unconfigured" };
      }
      const reach = probeS3Reachability(remote);
      if (reach === "ok") return { reachable: true, detail: "S3 reachable" };
      if (reach === "unreachable") return { reachable: false, detail: "S3 unreachable" };
      return { unknown: true, detail: "S3 unmeasured" };
    },
    probeGithub() {
      const problem = gitRootProblem();
      if (problem) return { unknown: true, detail: problem };
      const ls = git(gitVault, ["ls-remote", "origin", "refs/heads/main"], {
        timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
      });
      const oid = ls.split(/\s+/)[0];
      if (!oid) return { unknown: true, detail: "git ls-remote origin main failed" };
      const originMain = git(gitVault, ["rev-parse", "--verify", "origin/main"]);
      let ageHours: number | undefined;
      if (originMain && originMain === oid) {
        const ct = git(gitVault, ["log", "-1", "--format=%ct", "origin/main"]);
        const sec = Number.parseInt(ct, 10);
        if (Number.isFinite(sec) && sec > 0) {
          ageHours = Math.max(0, Math.round((Date.now() / 1000 - sec) / 3600));
        }
      }
      return { oid, ageHours, detail: "git ls-remote origin main" };
    },
    probeLocalGit() {
      const problem = gitRootProblem();
      if (problem) return { unknown: true, detail: problem };
      const head = git(gitVault, ["rev-parse", "HEAD"]);
      if (!head) return { unknown: true, detail: "HEAD unreadable" };
      const behindRaw = git(gitVault, ["rev-list", "--count", "HEAD..origin/main"]);
      const behind = behindRaw === "" ? undefined : Number.parseInt(behindRaw, 10);
      const review = listReviewRequiredOps(gitVault)[0];
      const blockedReason = review
        ? `review-required:${review.opId}`
        : undefined;
      const dirty = measureDirtyVolume(gitVault);
      const dirtyCount = dirty.is_git_repo ? dirty.expanded_files : undefined;
      const untrackedCount = dirty.is_git_repo ? dirty.untracked : undefined;
      const ledgerUntracked = dirty.is_git_repo ? countEventLedgerFiles(gitVault) : undefined;
      const contentUntracked = dirty.is_git_repo ? dirty.content_files : undefined;
      const dirtyHint =
        ledgerUntracked && ledgerUntracked > 0
          ? `event-ledger live-ahead of GitHub; do not git add`
          : dirtyCount && dirtyCount > 0
            ? `live-ahead of GitHub; do not git add`
          : undefined;
      const detail = [dirtyHint, blockedReason, projectionWarning].filter(Boolean).join("; ") || undefined;
      return {
        head,
        behind: Number.isFinite(behind) ? behind : undefined,
        blockedReason,
        dirty: dirtyCount,
        untracked: untrackedCount,
        ledger_untracked: ledgerUntracked && ledgerUntracked > 0 ? ledgerUntracked : undefined,
        content_untracked: contentUntracked && contentUntracked > 0 ? contentUntracked : undefined,
        detail,
      };
    },
    probeLiveDrift() {
      if (!configuredProjection) {
        return { unknown: true, detail: projectionProblem ?? "live drift requires a configured fetch projection" };
      }
      if (!existsSync(join(configuredProjection, ".git"))) {
        return { unknown: true, detail: invalidProjectionDetail };
      }
      return measureAuthoritativeLiveDrift(input.vault, configuredProjection);
    },
  };
}

export async function runCopyStatusCommand(
  input: CopyStatusInput,
): Promise<{ exitCode: number; result: Result<CopyStatusOutput> }> {
  if (!existsSync(input.vault)) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) };
  }
  const data = await runCopyStatusCore(input.deps ?? defaultCopyStatusDeps(input));
  return { exitCode: ExitCode.OK, result: ok(data) };
}
