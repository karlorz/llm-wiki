import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";

export type JournalFields = Record<string, string>;

export function journalDir(vault: string): string | null {
  const gitPath = git(vault, ["rev-parse", "--git-path", "vault-sync/operations"]);
  if (!gitPath) return null;
  return gitPath.startsWith("/") ? gitPath : join(vault, gitPath);
}

export function parseJournalEnv(text: string): JournalFields {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)] as const;
      }),
  );
}

export function serializeJournalEnv(fields: JournalFields, preferredOrder: string[] = []): string {
  const keys = [...preferredOrder.filter((k) => k in fields), ...Object.keys(fields).filter((k) => !preferredOrder.includes(k))];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`${k}=${fields[k]}`);
  }
  return lines.join("\n") + "\n";
}

export function readJournal(vault: string, opId: string): JournalFields | null {
  const dir = journalDir(vault);
  if (!dir) return null;
  const path = join(dir, `${opId}.env`);
  if (!existsSync(path)) return null;
  try {
    return parseJournalEnv(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJournal(vault: string, opId: string, fields: JournalFields): boolean {
  const dir = journalDir(vault);
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${opId}.env`);
    const tmp = `${path}.tmp.${process.pid}`;
    const order = [
      "operation_id",
      "phase",
      "retry_count",
      "original_branch",
      "original_head",
      "target_oid",
      "owned_stash_oid",
      "preservation_scope",
      "lock_identity",
      "helper_version",
      "deployed_runtime_hash",
      "conflict_identity",
      "handoff",
      "reason",
      "prior_reason",
      "superseded_at",
      "cleared_reason",
      "cleared_by",
      "worktree_path",
      "worktree_git_dir",
      "inventory_path",
    ];
    writeFileSync(tmp, serializeJournalEnv(fields, order), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export function listJournalOpIds(vault: string): string[] {
  const dir = journalDir(vault);
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".env"))
      .map((f) => f.replace(/\.env$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export function listReviewRequiredOps(vault: string): Array<{ opId: string; fields: JournalFields }> {
  const currentGitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  const out: Array<{ opId: string; fields: JournalFields }> = [];
  for (const opId of listJournalOpIds(vault)) {
    const fields = readJournal(vault, opId);
    if (!fields) continue;
    if (fields.phase !== "review-required" || fields.handoff !== "1") continue;
    const journalGitDir = fields.worktree_git_dir ?? "";
    if (!journalGitDir || !currentGitDir || journalGitDir === currentGitDir) {
      out.push({ opId, fields });
    }
  }
  return out;
}

export function findReviewRequiredOp(vault: string): string | undefined {
  return listReviewRequiredOps(vault)[0]?.opId;
}

/** True when Git has unmerged paths. */
export function hasUnmergedPaths(vault: string): string[] {
  const unmergedRaw = git(vault, ["diff", "--name-only", "--diff-filter=U"]);
  return unmergedRaw
    ? unmergedRaw.split("\n").map((s) => s.trim()).filter(Boolean)
    : [];
}

/** True when MERGE/CHERRY_PICK/REVERT or rebase sequencer is active. */
export function hasActiveGitSequencer(vault: string): boolean {
  const gitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return false;
  for (const m of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (existsSync(join(gitDir, m))) return true;
  }
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) {
    return true;
  }
  return false;
}

export function isWorktreeClean(vault: string): boolean {
  const porcelain = git(vault, ["status", "--porcelain"]);
  return !porcelain || porcelain.trim() === "";
}

/**
 * Whether a single review-required journal is safe to supersede.
 * Criteria: clean worktree, idle sequencer, and target_oid is ancestor of HEAD
 * (or missing target treated as supersedable only when clean+idle — we require target).
 */
export function canSupersedeJournal(vault: string, fields: JournalFields): boolean {
  if (hasUnmergedPaths(vault).length > 0) return false;
  if (hasActiveGitSequencer(vault)) return false;
  if (!isWorktreeClean(vault)) return false;
  const target = fields.target_oid?.trim();
  if (!target) return false;
  const head = git(vault, ["rev-parse", "HEAD"]);
  if (!head) return false;
  // git() collapses exit codes: use merge-base equality (ancestor of tip ⇒ merge-base === ancestor).
  return gitMergeBaseIsAncestor(vault, target, head);
}

function gitMergeBaseIsAncestor(vault: string, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const mb = git(vault, ["merge-base", ancestor, tip]);
  return mb !== "" && mb === ancestor;
}

export function markJournalSuperseded(
  vault: string,
  opId: string,
  fields: JournalFields,
  by: string,
): boolean {
  const next: JournalFields = { ...fields };
  if (next.reason && next.reason !== "superseded-stale-review-required") {
    next.prior_reason = next.prior_reason || next.reason;
  }
  next.phase = "complete";
  next.reason = "superseded-stale-review-required";
  next.superseded_at = new Date().toISOString();
  next.cleared_by = by;
  next.cleared_reason = `operator-or-preflight ${next.superseded_at}`;
  // keep handoff=1 for audit trail of former handoff (matches operator clear on macos-dev)
  if (!next.handoff) next.handoff = "1";
  if (!next.operation_id) next.operation_id = opId;
  return writeJournal(vault, opId, next);
}

/**
 * Supersede all review-required journals that meet clean-worktree criteria.
 * Returns list of superseded operation ids.
 */
export function supersedeStaleReviewRequiredJournals(
  vault: string,
  opts: { dryRun?: boolean; by?: string } = {},
): { superseded: string[]; skipped: string[] } {
  const by = opts.by ?? "skillwiki-preflight";
  const superseded: string[] = [];
  const skipped: string[] = [];
  if (hasUnmergedPaths(vault).length > 0 || hasActiveGitSequencer(vault) || !isWorktreeClean(vault)) {
    for (const { opId } of listReviewRequiredOps(vault)) skipped.push(opId);
    return { superseded, skipped };
  }
  for (const { opId, fields } of listReviewRequiredOps(vault)) {
    if (!canSupersedeJournal(vault, fields)) {
      skipped.push(opId);
      continue;
    }
    if (opts.dryRun) {
      superseded.push(opId);
      continue;
    }
    if (markJournalSuperseded(vault, opId, fields, by)) {
      superseded.push(opId);
    } else {
      skipped.push(opId);
    }
  }
  return { superseded, skipped };
}
