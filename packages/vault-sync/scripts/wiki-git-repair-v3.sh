#!/usr/bin/env bash
# Conservative snapshotter recovery. Preserve local commits and dirty S3 bytes;
# true divergence requires attended review, never reset/stash/clean/rebase-abort.
set -euo pipefail

WORKTREE="${WIKI_GIT_WORKTREE:-${SNAPSHOT_WORKTREE:-${WIKI_SNAPSHOT_WORKTREE:-/root/wiki-git}}}"
log() { printf '%s [wiki-git-repair] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
refuse() { log "ERROR: $*; fail closed"; exit 1; }

cd "$WORKTREE" || refuse "cannot cd to $WORKTREE"
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || refuse "not a git worktree: $WORKTREE"

# Resolve worktree-private metadata through Git: .git may be a text file.
[ ! -e "$(git rev-parse --git-path index.lock)" ] || refuse "index.lock present"
[ ! -e "$(git rev-parse --git-path MERGE_HEAD)" ] || refuse "merge in progress"
unmerged="$(git diff --name-only --diff-filter=U)" || refuse "cannot inspect unmerged paths"
[ -z "$unmerged" ] || refuse "unmerged paths present"

for state in rebase-merge rebase-apply; do
    state_dir="$(git rev-parse --git-path "$state")"
    [ -d "$state_dir" ] || continue
    todo="$state_dir/git-rebase-todo"
    [ -f "$todo" ] && [ -r "$todo" ] || refuse "active rebase sequencer without readable todo"
    [ -z "$(tr -d '[:space:]' < "$todo")" ] || refuse "rebase todo is not empty"
    recovery_ref="refs/vault-sync/recovery/stale-rebase-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    git update-ref "$recovery_ref" HEAD '' || refuse "cannot create recovery ref"
    git rebase --quit || refuse "cannot quit stale-clean rebase (recovery ref $recovery_ref)"
    log "stale-clean rebase quit; recovery ref $recovery_ref"
done

git symbolic-ref -q HEAD >/dev/null || refuse "detached HEAD"
git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main || refuse "cannot fetch origin/main"
head_oid="$(git rev-parse --verify HEAD)"
origin_oid="$(git rev-parse --verify origin/main)"
if [ "$head_oid" = "$origin_oid" ]; then
    log "HEAD matches origin/main"
elif git merge-base --is-ancestor "$head_oid" "$origin_oid"; then
    git merge --ff-only --no-autostash origin/main || refuse "fast-forward to origin/main failed"
    log "fast-forwarded to origin/main"
elif git merge-base --is-ancestor "$origin_oid" "$head_oid"; then
    log "local HEAD is ahead of origin/main; leaving commits for snapshot push"
else
    refuse "true divergence HEAD=$head_oid origin=$origin_oid; no reset"
fi
