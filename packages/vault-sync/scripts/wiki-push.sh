#!/bin/bash
# wiki-push.sh — one-way push from ~/wiki to SeaweedFS S3 via rclone copy.
#
# Push-only (rclone copy, NOT sync) — NEVER deletes files on the remote.
# Pull side is handled separately by:
#   - Obsidian Remotely Save (option 5: Incremental Pull And Delete), or
#   - git pull from GitHub (sg01 hourly snapshot path).
#
# This script complements wiki-fetch-notify (which polls GitHub) by giving macOS-authored
# notes a direct path to S3 → pvelxc agents in ~60 s instead of waiting for the next
# wiki-sync push and sg01 snapshot cycle.
#
# Lockfile prevents overlapping runs if a push takes longer than the launchd interval.
# Safe by default: no flag = real run (no dry-run mode — meant to be unattended).

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
. "$SCRIPT_DIR/lib/platform.sh"
. "$SCRIPT_DIR/lib/lockfile.sh"
platform_detect_os

WIKI_DIR="${WIKI_DIR:-$HOME/wiki}"
REMOTE="${WIKI_REMOTE:-seaweed-wiki:cloud/wiki}"
FILTERS="${WIKI_PUSH_FILTERS:-$(platform_rclone_config_dir)/wiki-push-filters.txt}"
LOCK_FILE="$(platform_cache_dir)/wiki-push.lock"
LOG_FILE="$(platform_log_dir)/wiki-push.log"
LOG_MAX_SIZE=1048576  # 1 MB
LOG_KEEP=5

mkdir -p "$(dirname "$LOCK_FILE")" "$(dirname "$LOG_FILE")"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"; }

# Rotate log if oversized.
if [ -f "$LOG_FILE" ] && [ "$(platform_stat_size "$LOG_FILE")" -gt "$LOG_MAX_SIZE" ]; then
    for i in $(seq $((LOG_KEEP - 1)) -1 1); do
        [ -f "$LOG_FILE.$i" ] && mv "$LOG_FILE.$i" "$LOG_FILE.$((i + 1))"
    done
    mv "$LOG_FILE" "$LOG_FILE.1"
fi

# Guard: wiki dir present.
if [ ! -d "$WIKI_DIR" ]; then
    log "ERROR: WIKI_DIR not found at $WIKI_DIR"
    exit 0
fi

# Guard: filter file present (it's not strictly required, but missing it would push .git/).
if [ ! -f "$FILTERS" ]; then
    log "ERROR: filter file missing at $FILTERS — refusing to push without exclusions"
    exit 0
fi

# Acquire lockfile (non-blocking).
LOCK_RC=0
lockfile_acquire "$LOCK_FILE" 600 || LOCK_RC=$?
if [ "$LOCK_RC" -eq 1 ]; then
    log "skip: previous run still in flight"
    exit 0
elif [ "$LOCK_RC" -eq 2 ]; then
    log "stale lock reclaimed"
fi

START=$(date +%s)

# rclone copy (NOT sync) → never deletes on remote.
# --update : only newer source files overwrite remote (mod-time + size based)
# --filter-from : reuse the bisync filter list
# --transfers 4 : modest parallelism for small files
# --checkers 8 : default-ish
# --low-level-retries 10 --retries 3 : tolerate transient network blips
OUTPUT=$(rclone copy "$WIKI_DIR" "$REMOTE" \
    --filter-from "$FILTERS" \
    --update \
    --transfers 4 \
    --checkers 8 \
    --low-level-retries 10 \
    --retries 3 \
    --stats-one-line \
    --stats 60s 2>&1)
RC=$?

DURATION=$(( $(date +%s) - START ))

GIT_OK=true
if [ "$RC" -eq 0 ]; then
    # rclone with --stats-one-line emits a "Transferred: N / N, 100%, ..." line on completion.
    STATS_LINE=$(printf '%s\n' "$OUTPUT" | grep -E '^Transferred:.*[0-9]+ B' | tail -1)
    if [ -n "$STATS_LINE" ]; then
        log "OK push duration=${DURATION}s | $STATS_LINE"
    else
        log "OK push (no changes) duration=${DURATION}s"
    fi
else
    log "FAIL rclone exit=$RC duration=${DURATION}s"
    printf '%s\n' "$OUTPUT" >>"$LOG_FILE"
    GIT_OK=false
fi

# --- git auto-push to GitHub ---
# Keep GitHub in sync so manual git pull doesn't hit divergence/conflicts.
# This is non-blocking — failure does not affect the rclone result.
if [ "$GIT_OK" = true ] && [ -d "$WIKI_DIR/.git" ]; then
    cd "$WIKI_DIR" || { log "GIT cd failed"; exit 0; }

    # Pre-push pull with auto-resolve for conflict storms
    # If sg01 pushed snapshot commits since last cycle, this prevents push rejection.
    git fetch --quiet origin main 2>>"$LOG_FILE"
    BEHIND=$(git rev-list --count "HEAD..origin/main" 2>/dev/null || echo 0)
    if [ "$BEHIND" -gt 0 ]; then
        # Use the auto-resolve helper script
        AUTO_RESOLVE="$SCRIPT_DIR/wiki-pull-with-auto-resolve.sh"
        if [ -x "$AUTO_RESOLVE" ]; then
            "$AUTO_RESOLVE" origin main 2>>"$LOG_FILE" && log "GIT pre-push pull ok" || log "GIT pre-push pull failed (non-blocking)"
        else
            # Fallback: plain rebase
            git pull --rebase origin main 2>>"$LOG_FILE" && log "GIT pre-push pull ok" || log "GIT pre-push pull failed (non-blocking)"
        fi
    fi

    # Check for changes before committing
    if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
        log "GIT no changes to commit"
    else
        git add -A 2>>"$LOG_FILE"
        git commit -m "auto: wiki sync $(date -u +%Y-%m-%dT%H:%MZ)" 2>>"$LOG_FILE"
        GIT_COMMIT_RC=$?
        if [ "$GIT_COMMIT_RC" -eq 0 ]; then
            git push origin main 2>>"$LOG_FILE"
            GIT_PUSH_RC=$?
            if [ "$GIT_PUSH_RC" -eq 0 ]; then
                log "OK git push succeeded"
            else
                log "FAIL git push exit=$GIT_PUSH_RC (non-blocking)"
            fi
        elif [ "$GIT_COMMIT_RC" -eq 1 ]; then
            # Exit code 1 from git commit means nothing to commit (shouldn't
            # reach here after the porcelain check, but just in case)
            log "GIT nothing to commit"
        else
            log "FAIL git commit exit=$GIT_COMMIT_RC (non-blocking)"
        fi
    fi
fi

exit 0
