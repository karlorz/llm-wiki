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
. "$SCRIPT_DIR/lib/conflict-markers.sh"
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

conflict_marker_guard() {
    local findings
    findings="$(mktemp)" || { log "FAIL could not create conflict-marker scan temp file"; return 1; }
    if ! vault_sync_scan_conflict_markers "$WIKI_DIR" "$findings"; then
        log "FAIL conflict marker blocks present; refusing S3 push"
        vault_sync_log_conflict_marker_findings "$findings" "$LOG_FILE"
        rm -f "$findings"
        return 1
    fi
    rm -f "$findings"
    return 0
}

remote_prune_archived_source_paths() {
    local max_remote_deletes="${WIKI_PUSH_MAX_REMOTE_DELETES:-10}"
    case "$max_remote_deletes" in
        ''|*[!0-9]*)
            log "FAIL remote prune invalid WIKI_PUSH_MAX_REMOTE_DELETES=$max_remote_deletes"
            return 1
            ;;
    esac
    if [ "$max_remote_deletes" -lt 1 ]; then
        log "FAIL remote prune invalid WIKI_PUSH_MAX_REMOTE_DELETES=$max_remote_deletes"
        return 1
    fi

    local tmp_dir archive_pairs remote_paths plan_file
    tmp_dir="$(mktemp -d)"
    archive_pairs="$tmp_dir/archive-pairs.tsv"
    remote_paths="$tmp_dir/remote-paths.txt"
    plan_file="$tmp_dir/plan.txt"

    if [ ! -d "$WIKI_DIR/_archive" ]; then
        rm -rf "$tmp_dir"
        return 0
    fi

    (
        cd "$WIKI_DIR" || exit 1
        find _archive -type f | while IFS= read -r archive_path; do
            local source_path="${archive_path#_archive/}"
            [ "$source_path" = "$archive_path" ] && continue
            [ -e "$source_path" ] && continue
            printf '%s\t%s\n' "$source_path" "$archive_path"
        done | LC_ALL=C sort -u
    ) > "$archive_pairs" || {
        log "FAIL remote prune could not enumerate _archive pairs"
        rm -rf "$tmp_dir"
        return 1
    }

    if [ ! -s "$archive_pairs" ]; then
        rm -rf "$tmp_dir"
        return 0
    fi

    if ! rclone lsf "$REMOTE" --recursive --files-only 2>>"$LOG_FILE" | LC_ALL=C sort -u > "$remote_paths"; then
        log "FAIL remote prune could not list remote paths"
        rm -rf "$tmp_dir"
        return 1
    fi

    while IFS="$(printf '\t')" read -r source_path archive_path; do
        [ -z "$source_path" ] && continue
        if grep -Fxq -- "$source_path" "$remote_paths" && grep -Fxq -- "$archive_path" "$remote_paths"; then
            printf '%s\n' "$source_path"
        fi
    done < "$archive_pairs" | LC_ALL=C sort -u > "$plan_file"

    local planned_count
    planned_count="$(wc -l < "$plan_file" | tr -d ' ')"
    if [ "$planned_count" = "0" ]; then
        rm -rf "$tmp_dir"
        return 0
    fi
    if [ "$planned_count" -gt "$max_remote_deletes" ]; then
        log "FAIL remote prune cap exceeded: $planned_count > $max_remote_deletes"
        sed 's/^/remote prune skipped: /' "$plan_file" >> "$LOG_FILE"
        rm -rf "$tmp_dir"
        return 1
    fi

    local rel_path remote_path
    while IFS= read -r rel_path; do
        [ -z "$rel_path" ] && continue
        remote_path="${REMOTE%/}/$rel_path"
        if rclone deletefile "$remote_path" >>"$LOG_FILE" 2>&1; then
            log "OK remote pruned archived source $remote_path"
        else
            log "FAIL remote prune deletefile failed for $remote_path"
            rm -rf "$tmp_dir"
            return 1
        fi
    done < "$plan_file"

    rm -rf "$tmp_dir"
    return 0
}

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

if ! conflict_marker_guard; then
    exit 1
fi

# rclone copy (NOT sync) → never bulk-deletes on remote.
# After a successful copy, prune only those stale live paths whose matching
# _archive/<path> object is now present on the remote and whose live path is
# absent locally. This keeps archive moves from leaving stale live note paths
# on S3 without reintroducing git pushes on macOS.
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

if [ "$RC" -eq 0 ]; then
    if ! remote_prune_archived_source_paths; then
        log "FAIL remote prune failed after rclone copy"
    fi
fi

exit 0
