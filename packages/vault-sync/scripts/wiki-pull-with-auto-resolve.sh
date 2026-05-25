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
platform_detect_os

WIKI_DIR="${WIKI_DIR:-$HOME/wiki}"
REMOTE="${1:-origin}"
BRANCH="${2:-main}"
LOG_FILE="$(platform_log_dir)/wiki-pull.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"; }

cd "$WIKI_DIR" || { log "ERROR: cd $WIKI_DIR failed"; exit 1; }

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

# Run rebase with auto-resolve for archive conflict storms
#
# GIT_SEQUENCE_EDITOR trick: we use a noop editor and let rebase run.
# When conflicts occur, we check if the commit being applied is an
# archive-only commit and auto-resolve.

# Set up a rebase helper that fires on each conflict
export GIT_SEQUENCE_EDITOR=:

# Run rebase with an automatic conflict resolver via rebase --resolv
# Since git doesn't natively support --ours per commit type, we use a
# custom merge driver approach: set the rebase to stop on conflicts,
# then detect and auto-resolve archive commits.

# Use GIT_EDITOR trick: git rebase stops on conflict, we detect and resolve
git pull --rebase "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"
REBASE_RC=$?

while [ $REBASE_RC -ne 0 ]; do
    # Check if we're in a rebase conflict state
    if [ ! -d "$WIKI_DIR/.git/rebase-merge" ]; then
        # Not in a rebase — some other error
        log "FAIL pull (not a rebase conflict, rc=$REBASE_RC)"
        exit $REBASE_RC
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

log "OK pull completed"
exit 0
