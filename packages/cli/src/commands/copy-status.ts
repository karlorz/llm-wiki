import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { git } from "../utils/git.js";
import { listReviewRequiredOps } from "../utils/operation-journal.js";
import {
  probeS3Reachability,
  resolveWikiS3Remote,
  REMOTE_PROBE_TIMEOUT_MS,
} from "../utils/remote-health.js";
import { measureDirtyVolume } from "../utils/vault-write-gates.js";
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

export function defaultCopyStatusDeps(input: CopyStatusInput): CopyStatusDeps {
  return {
    probeLive() {
      if (input.s3Ok === true) return { reachable: true, detail: "MCP S3 ok" };
      if (input.s3Ok === false) return { reachable: false, detail: "MCP S3 not ok" };
      const remote = resolveWikiS3Remote({ home: input.home });
      if (!remote) {
        return { unknown: true, detail: "leaf clone is not the live plane; S3 remote unconfigured" };
      }
      const reach = probeS3Reachability(remote);
      if (reach === "ok") return { reachable: true, detail: "S3 reachable" };
      if (reach === "unreachable") return { reachable: false, detail: "S3 unreachable" };
      return { unknown: true, detail: "S3 unmeasured" };
    },
    probeGithub() {
      if (!existsSync(join(input.vault, ".git"))) {
        return { unknown: true, detail: "vault is not a git repository" };
      }
      const ls = git(input.vault, ["ls-remote", "origin", "refs/heads/main"], {
        timeoutMs: REMOTE_PROBE_TIMEOUT_MS,
      });
      const oid = ls.split(/\s+/)[0];
      if (!oid) return { unknown: true, detail: "git ls-remote origin main failed" };
      const originMain = git(input.vault, ["rev-parse", "--verify", "origin/main"]);
      let ageHours: number | undefined;
      if (originMain && originMain === oid) {
        const ct = git(input.vault, ["log", "-1", "--format=%ct", "origin/main"]);
        const sec = Number.parseInt(ct, 10);
        if (Number.isFinite(sec) && sec > 0) {
          ageHours = Math.max(0, Math.round((Date.now() / 1000 - sec) / 3600));
        }
      }
      return { oid, ageHours, detail: "git ls-remote origin main" };
    },
    probeLocalGit() {
      if (!existsSync(join(input.vault, ".git"))) {
        return { unknown: true, detail: "vault is not a git repository" };
      }
      const head = git(input.vault, ["rev-parse", "HEAD"]);
      if (!head) return { unknown: true, detail: "HEAD unreadable" };
      const behindRaw = git(input.vault, ["rev-list", "--count", "HEAD..origin/main"]);
      const behind = behindRaw === "" ? undefined : Number.parseInt(behindRaw, 10);
      const review = listReviewRequiredOps(input.vault)[0];
      const blockedReason = review
        ? `review-required:${review.opId}`
        : undefined;
      const dirty = measureDirtyVolume(input.vault);
      const dirtyCount = dirty.is_git_repo ? dirty.expanded_files : undefined;
      const untrackedCount = dirty.is_git_repo ? dirty.untracked : undefined;
      const ledgerUntracked = dirty.is_git_repo ? dirty.ledger_files : undefined;
      const contentUntracked = dirty.is_git_repo ? dirty.content_files : undefined;
      const dirtyHint =
        dirtyCount && dirtyCount > 0
          ? ledgerUntracked && ledgerUntracked > 0
            ? `event-ledger live-ahead of GitHub; do not git add`
            : `live-ahead of GitHub; do not git add`
          : undefined;
      return {
        head,
        behind: Number.isFinite(behind) ? behind : undefined,
        blockedReason,
        dirty: dirtyCount,
        untracked: untrackedCount,
        ledger_untracked: dirtyCount && dirtyCount > 0 ? ledgerUntracked : undefined,
        content_untracked: dirtyCount && dirtyCount > 0 ? contentUntracked : undefined,
        detail: dirtyHint ?? blockedReason,
      };
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
