#!/bin/bash
# wiki-push.sh — one-way push from ~/wiki to SeaweedFS S3 via rclone copy.
#
# Push-only (rclone copy, NOT sync) — NEVER deletes files on the remote.
# Pull side is handled separately by:
#   - Obsidian Remotely Save (option 5: Incremental Pull And Delete), or
#   - wiki-fetch-notify.sh (opt-in WIKI_FETCH_PULL_ON_DELTA=1 performs
#     git pull --rebase on positive delta), or
#   - manual `skillwiki sync` / `wiki-sync` skill.
#
# This script is the SOLE macOS → S3 transport. It does NOT touch git —
# single-writer-git is enforced: only sg01's wiki-snapshot.sh pushes to
# GitHub (concepts/vault-write-authority-model.md D2, D3, D6). macOS
# consumes sg01 Snapshot commits via the pull mechanisms above.
#
# Lockfile prevents overlapping runs if a push takes longer than the launchd interval.
# Safe by default: no flag = real run (no dry-run mode — meant to be unattended).

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
. "$SCRIPT_DIR/lib/platform.sh"
. "$SCRIPT_DIR/lib/lockfile.sh"
. "$SCRIPT_DIR/lib/git-case.sh"
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

if ! CASE_CONFLICTS=$(cd "$WIKI_DIR" && git_case_conflicts); then
    log "ERROR: case-only path collision detected — refusing rclone push"
    printf '%s\n' "$CASE_CONFLICTS" >>"$LOG_FILE"
    exit 0
fi

# Fix Windows-hostile markdown paths before publishing to S3.
# The skillwiki CLI owns the rename and citation-rewire semantics; this script
# only gates the unattended push pipeline.
if command -v skillwiki >/dev/null 2>&1; then
    PATH_FIX_OUTPUT=$(skillwiki lint "$WIKI_DIR" --only path_too_long --fix 2>&1)
    PATH_FIX_RC=$?
    printf '%s\n' "$PATH_FIX_OUTPUT" >>"$LOG_FILE"
    if [ "$PATH_FIX_RC" -ne 0 ]; then
        log "ERROR: path_too_long fix failed exit=$PATH_FIX_RC — refusing rclone push"
        exit 0
    fi
else
    log "ERROR: skillwiki CLI not found — refusing push because path_too_long guard cannot run"
    exit 0
fi

# rclone copy (NOT sync) → never bulk-deletes on remote.
# Stale archived source paths on S3 are pruned by the sg01 snapshot path
# (wiki-snapshot.sh rclone sync with --max-delete guard), not by this script.
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
fi

exit 0
