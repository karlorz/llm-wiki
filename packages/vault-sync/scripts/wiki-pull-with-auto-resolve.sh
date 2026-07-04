#!/bin/bash
# wiki-pull-with-auto-resolve.sh — git pull --rebase with archive-commit conflict storm
# auto-resolution.
#
# When git pull --rebase hits content conflicts on archive-only commits
# (message matches "^archive: moved"), auto-resolve all conflicts with
# --ours (keep HEAD) and continue. Non-archive conflicts are left for
# manual resolution.
#
# Usage:
#   wiki-pull-with-auto-resolve.sh [--remote <name>] [--branch <name>]
#   Defaults: origin, main

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
. "$SCRIPT_DIR/lib/platform.sh"
. "$SCRIPT_DIR/lib/lockfile.sh"
. "$SCRIPT_DIR/lib/git-case.sh"
platform_detect_os

WIKI_DIR="${WIKI_DIR:-$HOME/wiki}"
REMOTE="${1:-origin}"
BRANCH="${2:-main}"
LOG_FILE="$(platform_log_dir)/wiki-pull.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"; }

drop_identical_untracked_remote_overlaps() {
    local removed=0
    local path remote_blob

    while IFS= read -r -d '' path; do
        if ! git cat-file -e "$REMOTE/$BRANCH:$path" 2>/dev/null; then
            continue
        fi

        remote_blob="$(mktemp)"
        if git show "$REMOTE/$BRANCH:$path" >"$remote_blob" 2>/dev/null && cmp -s "$path" "$remote_blob"; then
            if rm -f -- "$path"; then
                removed=$((removed + 1))
            else
                rm -f "$remote_blob"
                log "FAIL could not remove untracked remote duplicate before pull: $path"
                return 1
            fi
        else
            rm -f "$remote_blob"
            log "FAIL untracked path would be overwritten by remote and differs: $path"
            return 1
        fi
        rm -f "$remote_blob"
    done < <(git ls-files --others --exclude-standard -z)

    if [ "$removed" -gt 0 ]; then
        log "DROP $removed identical untracked remote duplicate(s) before pull"
    fi
    return 0
}

cd "$WIKI_DIR" || { log "ERROR: cd $WIKI_DIR failed"; exit 1; }

# Clean up leftover rebase state from a previous failed unattended run. An
# empty/corrupt rebase-merge directory is enough to block the next pull.
if [ -d "$WIKI_DIR/.git/rebase-merge" ] || [ -d "$WIKI_DIR/.git/rebase-apply" ]; then
    log "CLEANUP stale rebase state from previous run"
    git rebase --abort 2>>"$LOG_FILE" || true
    if ! git rev-parse -q --verify REBASE_HEAD >/dev/null 2>&1; then
        rm -rf "$WIKI_DIR/.git/rebase-merge" "$WIKI_DIR/.git/rebase-apply"
    fi
fi

if ! CASE_CONFLICTS=$(git_case_conflicts); then
    log "FAIL case-only path collision detected"
    printf '%s\n' "$CASE_CONFLICTS" >>"$LOG_FILE"
    exit 1
fi

# Do a git fetch first to be safe
git fetch --quiet "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"
log "FETCH $REMOTE/$BRANCH"

# Check if we're behind
BEHIND=$(git rev-list --count "HEAD..$REMOTE/$BRANCH" 2>/dev/null || echo 0)
if [ "$BEHIND" -eq 0 ]; then
    log "UP-TO-DATE (0 behind)"
    exit 0
fi

log "PULL --rebase ($BEHIND commits behind)"

if ! drop_identical_untracked_remote_overlaps; then
    exit 1
fi

STASHED=false
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    STASH_MSG="wiki-pull auto-stash $(date -u +%Y-%m-%dT%H:%MZ)"
    if git stash push -m "$STASH_MSG" 2>>"$LOG_FILE" >/dev/null; then
        STASHED=true
        log "STASH local tracked edits before rebase"
    else
        log "FAIL stash before rebase"
        exit 1
    fi
fi

# Run rebase with auto-resolve for archive conflict storms.
# --reapply-cherry-picks prevents git from skipping matching patch-ids and
# dirtying the working tree mid-rebase.
export GIT_SEQUENCE_EDITOR=:
git -c rebase.reapplyCherryPicks=true pull --rebase "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"
REBASE_RC=$?

while [ $REBASE_RC -ne 0 ]; do
    # Check if we're in a rebase conflict state
    if [ ! -d "$WIKI_DIR/.git/rebase-merge" ]; then
        # Rebase failed before starting. Fall back to a normal merge so the
        # unattended push loop does not wedge on recoverable non-rebase errors.
        log "REBASE failed to start (rc=$REBASE_RC) — falling back to merge"
        git rebase --abort 2>/dev/null || true
        if git merge --no-edit "$REMOTE/$BRANCH" 2>>"$LOG_FILE"; then
            log "OK fallback merge succeeded"
            REBASE_RC=0
        else
            log "FAIL fallback merge also failed"
            exit 1
        fi
        continue
    fi

    # Check if there are actual conflicts
    CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null)
    if [ -z "$CONFLICTS" ]; then
        # No file-level conflicts — maybe the conflict was resolved externally
        # or it's a different kind of failure. Try to continue.
        if ! GIT_EDITOR=true git rebase --continue 2>>"$LOG_FILE"; then
            log "FAIL rebase continue (no conflicts but failed)"
            exit 1
        fi
        REBASE_RC=$?
        continue
    fi

    # Detect if current commit is archive-only
    STOPPED_SHA=$(cat "$WIKI_DIR/.git/rebase-merge/stopped-sha" 2>/dev/null || echo "")
    if [ -z "$STOPPED_SHA" ]; then
        log "WARN cannot determine stopped-sha — surfacing conflicts"
        exit 1
    fi

    COMMIT_MSG=$(git log --format=%s -1 "$STOPPED_SHA" 2>/dev/null || echo "")
    if echo "$COMMIT_MSG" | grep -qE "^archive: moved|^Snapshot "; then
        # Archive or snapshot commit — auto-resolve with --ours
        log "AUTO-RESOLVE ($COMMIT_MSG): $CONFLICTS"
        for f in $CONFLICTS; do
            git checkout --ours "$f" 2>/dev/null && git add "$f"
        done
    else
        # Non-archive conflict — surface to user
        log "MANUAL-RESOLVE-NEEDED ($COMMIT_MSG): $CONFLICTS"
        echo "=== CONFLICT on non-archive commit ==="
        echo "Commit: $COMMIT_MSG"
        echo "Conflicted files:"
        echo "$CONFLICTS"
        echo ""
        echo "Resolve manually, then run: git rebase --continue"
        exit 1
    fi

    # Continue rebase
    if ! GIT_EDITOR=true git rebase --continue 2>>"$LOG_FILE"; then
        REBASE_RC=$?
    else
        REBASE_RC=0
    fi
done

if [ "$STASHED" = true ]; then
    if git stash pop 2>>"$LOG_FILE" >/dev/null; then
        log "STASH pop ok"
    else
        log "FAIL stash pop after rebase"
        exit 1
    fi
fi

log "OK pull completed"
exit 0
