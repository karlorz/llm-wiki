#!/bin/bash
# wiki-snapshot.sh — Linux-only S3 → git snapshot/promotion job.
#
# Source-of-truth: this is the canonical vault-sync copy. The deployed copy on
# sg01 lives under /root/.local/share/vault-sync/bin; Hermes is not part of the
# production snapshot path. See work item:
#   projects/llm-wiki/work/2026-05-25-vault-sync-plugin-scaffold/
#
# Origin: migrated 2026-05-25 from sg01 wiki-snapshot-v3.sh (sha256:
#   037b05ddb6b47e377c3ef493e69730bc3ff3e3ccaa51d56edb7027091582f383).
#
# Hard Rule (NON-NEGOTIABLE):
#   The --max-delete 10 guard in RCLONE_OPTS MUST be preserved.
#   Without it, momentary S3 inconsistency mass-deletes files from GitHub.
#   Reference: raw/transcripts/2026-05-23-bug-sg01-snapshot-destructive-rclone-sync.md
#
# Single-writer-git invariant: only ONE host per vault remote may run this.
#   sg01 is the current snapshotter (role: snapshotter in fleet.yaml).
#   Running on a second host violates the authority model.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${GIT_DIR:-}" ]; then
    echo "[wiki-snapshot] WARNING: ignoring exported GIT_DIR; use WIKI_GIT_WORKTREE for the snapshot worktree" >&2
    unset GIT_DIR
fi

# Source platform.sh — handles both dev (scripts/lib/) and deployed (lib/) layouts
if [ -f "$SCRIPT_DIR/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/lib/platform.sh"
elif [ -f "$SCRIPT_DIR/scripts/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/scripts/lib/platform.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/platform.sh"
fi
platform_detect_os

if [ -f "$SCRIPT_DIR/lib/git-case.sh" ]; then
    source "$SCRIPT_DIR/lib/git-case.sh"
elif [ -f "$SCRIPT_DIR/scripts/lib/git-case.sh" ]; then
    source "$SCRIPT_DIR/scripts/lib/git-case.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/git-case.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/git-case.sh"
fi

if [ -f "$SCRIPT_DIR/lib/conflict-markers.sh" ]; then
    source "$SCRIPT_DIR/lib/conflict-markers.sh"
elif [ -f "$SCRIPT_DIR/scripts/lib/conflict-markers.sh" ]; then
    source "$SCRIPT_DIR/scripts/lib/conflict-markers.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/conflict-markers.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/conflict-markers.sh"
fi

if [ -f "$SCRIPT_DIR/lib/delete-intent.sh" ]; then
    source "$SCRIPT_DIR/lib/delete-intent.sh"
elif [ -f "$SCRIPT_DIR/scripts/lib/delete-intent.sh" ]; then
    source "$SCRIPT_DIR/scripts/lib/delete-intent.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/delete-intent.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/delete-intent.sh"
fi

if [ -f "$SCRIPT_DIR/lib/runtime-manifest.sh" ]; then
    source "$SCRIPT_DIR/lib/runtime-manifest.sh"
elif [ -f "$SCRIPT_DIR/scripts/lib/runtime-manifest.sh" ]; then
    source "$SCRIPT_DIR/scripts/lib/runtime-manifest.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/runtime-manifest.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/runtime-manifest.sh"
fi

if ! command -v vault_sync_scan_conflict_markers >/dev/null 2>&1; then
    echo "[wiki-snapshot] ERROR: conflict-marker helper unavailable; refusing to run." >&2
    exit 1
fi
if ! command -v vault_sync_sha256 >/dev/null 2>&1; then
    echo "[wiki-snapshot] ERROR: SHA-256 helper unavailable; refusing to run." >&2
    exit 1
fi

# ── Guard: Linux-only operation ────────────────────────────
platform_require linux

# ── Path configuration (env-overridable for plugin portability) ─
WIKI_DIR="${WIKI_DIR:-/root/wiki}"
SNAPSHOT_WORKTREE="${WIKI_GIT_WORKTREE:-${SNAPSHOT_WORKTREE:-/root/wiki-git}}"
LOCK_FILE="${WIKI_SNAPSHOT_LOCK:-/var/lock/wiki-snapshot.lock}"
DEFAULT_LOG_DIR="$(platform_log_dir)"
LOG_FILE="${WIKI_SNAPSHOT_LOG:-$DEFAULT_LOG_DIR/wiki-snapshot.log}"
INHIBIT_AFTER="${WIKI_SNAPSHOT_INHIBIT_AFTER:-3}"
INHIBIT_RECHECK_RUNS="${WIKI_SNAPSHOT_INHIBIT_RECHECK_RUNS:-6}"
INHIBIT_RECHECK_SECONDS="${WIKI_SNAPSHOT_INHIBIT_RECHECK_SECONDS:-21600}"
INHIBIT_STATE_FILE="${WIKI_SNAPSHOT_INHIBIT_STATE:-$(platform_cache_dir)/wiki-snapshot-inhibit.state}"
case "$INHIBIT_AFTER" in ''|*[!0-9]*) INHIBIT_AFTER=3 ;; esac
case "$INHIBIT_RECHECK_RUNS" in ''|*[!0-9]*) INHIBIT_RECHECK_RUNS=6 ;; esac
case "$INHIBIT_RECHECK_SECONDS" in ''|*[!0-9]*) INHIBIT_RECHECK_SECONDS=21600 ;; esac
if [ "$INHIBIT_AFTER" -lt 1 ]; then INHIBIT_AFTER=3; fi
if [ "$INHIBIT_RECHECK_RUNS" -lt 1 ]; then INHIBIT_RECHECK_RUNS=6; fi
CLOUD_REMOTE="${CLOUD_REMOTE:-cloud:cloud/wiki}"
REPAIR_SCRIPT="${WIKI_GIT_REPAIR_SCRIPT:-$SCRIPT_DIR/wiki-git-repair-v3.sh}"
MAX_S3_ONLY_NOTES="${WIKI_SNAPSHOT_MAX_S3_ONLY_NOTES:-200}"
MAX_TOMBSTONE_PRUNES="${WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES:-10}"
PROJECTION_PARITY_TIMEOUT_SECONDS="${WIKI_SNAPSHOT_PROJECTION_PARITY_TIMEOUT_SECONDS:-120}"
PROJECTION_PARITY_POLL_SECONDS="${WIKI_SNAPSHOT_PROJECTION_PARITY_POLL_SECONDS:-2}"
PROJECTION_READ_TIMEOUT_SECONDS="${WIKI_SNAPSHOT_PROJECTION_READ_TIMEOUT_SECONDS:-15}"
DATE=$(date +%Y%m%d_%H%M%S)
RCLONE_LOG="/tmp/rclone-${DATE}.log"
SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT=0
SNAPSHOT_REMOTE_INVENTORY_READY=0
PROJECTION_STATE_DIR=""
PROJECTION_EXPECTED_INDEX_SHA256=""
PROJECTION_EXPECTED_LOG_SHA256=""
SNAPSHOT_BASE_OID=""
SNAPSHOT_GIT_DIR=""
SNAPSHOT_GIT_COMMON_DIR=""

cleanup_projection_state() {
    if [ -n "$PROJECTION_STATE_DIR" ] && [ -d "$PROJECTION_STATE_DIR" ]; then
        rm -rf "$PROJECTION_STATE_DIR"
    fi
}
trap cleanup_projection_state EXIT

fetch_origin_main_ref() {
    # The snapshot guards read origin/main directly. Use an explicit destination
    # refspec so a damaged/minimal remote.fetch config cannot leave it stale.
    git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main
}

snapshot_refresh_origin_main() {
    (
        cd "$SNAPSHOT_WORKTREE" || exit 1
        fetch_origin_main_ref
    )
}

snapshot_load_active_delete_intent_paths() {
    local output_file="${1:-}"
    [ -n "$output_file" ] || return 1
    : > "$output_file" || return 1

    if command -v delete_intent_list_active_paths_from_git >/dev/null 2>&1 \
        && git -C "$SNAPSHOT_WORKTREE" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
        delete_intent_list_active_paths_from_git "$SNAPSHOT_WORKTREE" origin/main > "$output_file"
        return $?
    fi
    if command -v delete_intent_list_active_paths >/dev/null 2>&1; then
        delete_intent_list_active_paths "$SNAPSHOT_WORKTREE" > "$output_file"
        return $?
    fi
    return 1
}

snapshot_direct_s3_preflight() {
    local inventory_output="${1:-}"
    local active_paths_file="${2:-}"
    local tmp_dir
    tmp_dir="$(mktemp -d)" || {
        echo "[wiki-snapshot] WARN: direct-S3 preflight could not create temporary state"
        SNAPSHOT_REMOTE_INVENTORY_READY=0
        return 0
    }
    local direct_paths
    if [ -n "$inventory_output" ]; then
        direct_paths="$inventory_output"
    else
        direct_paths="$tmp_dir/direct-s3.paths"
    fi
    local direct_notes="$tmp_dir/direct-s3-notes.paths"
    local git_paths="$tmp_dir/git.paths"
    local direct_not_git_candidates="$tmp_dir/direct-s3-not-git-candidates.paths"
    local direct_not_git="$tmp_dir/direct-s3-not-git.paths"
    local active_sorted="$tmp_dir/active.paths"

    SNAPSHOT_REMOTE_INVENTORY_READY=0

    if ! rclone lsf "$CLOUD_REMOTE" --recursive --files-only 2>/dev/null | LC_ALL=C sort -u > "$direct_paths"; then
        echo "[wiki-snapshot] WARN: direct-S3 preflight could not list $CLOUD_REMOTE"
        rm -rf "$tmp_dir"
        return 0
    fi
    SNAPSHOT_REMOTE_INVENTORY_READY=1

    grep -vE '^(\.skillwiki/|\.claude/|\.obsidian/|\.antigravitycli/|\.playwright-cli/|raw/\._\.DS_Store$|\._\.DS_Store$)' "$direct_paths" | LC_ALL=C sort -u > "$direct_notes" || true
    (
        cd "$SNAPSHOT_WORKTREE" || exit 1
        if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
            git -c core.quotePath=false ls-tree -r --name-only origin/main
        else
            git -c core.quotePath=false ls-files
        fi | LC_ALL=C sort -u
    ) > "$git_paths" 2>/dev/null || {
        echo "[wiki-snapshot] WARN: direct-S3 preflight could not list tracked files in snapshot worktree $SNAPSHOT_WORKTREE"
        rm -rf "$tmp_dir"
        return 0
    }

    LC_ALL=C comm -23 "$direct_notes" "$git_paths" > "$direct_not_git_candidates"
    if [ -n "$active_paths_file" ] && [ -f "$active_paths_file" ]; then
        LC_ALL=C sort -u "$active_paths_file" > "$active_sorted"
        LC_ALL=C comm -23 "$direct_not_git_candidates" "$active_sorted" > "$direct_not_git"
    else
        LC_ALL=C sort -u "$direct_not_git_candidates" > "$direct_not_git"
    fi
    SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT="$(wc -l < "$direct_not_git" | tr -d ' ')"
    if [ "$SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT" != "0" ]; then
        echo "[wiki-snapshot] WARN: direct-S3-not-git warning: $SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT note path(s) exist in direct S3 but not in $SNAPSHOT_WORKTREE"
        sed -n '1,20p' "$direct_not_git" | sed 's/^/[wiki-snapshot] WARN: direct-S3-not-git: /'
        rm -rf "$tmp_dir"
        return 2
    fi

    rm -rf "$tmp_dir"
    return 0
}

handle_direct_s3_preflight_before_sync() {
    local tmp_dir active_paths
    tmp_dir="$(mktemp -d)" || {
        log "ERROR: could not create direct-S3 preflight state"
        return 1
    }
    active_paths="$tmp_dir/active.paths"
    if ! snapshot_refresh_origin_main 2>/dev/null; then
        log "WARNING: could not refresh origin/main before direct-S3 preflight; using the existing ref"
    fi
    if ! snapshot_load_active_delete_intent_paths "$active_paths"; then
        rm -rf "$tmp_dir"
        log "ERROR: active delete-intent inventory unavailable before direct-S3 preflight"
        return 1
    fi

    snapshot_direct_s3_preflight "" "$active_paths"
    local rc=$?
    rm -rf "$tmp_dir"
    if [ "$rc" -eq 0 ]; then
        return 0
    fi

    if [ "${WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES:-0}" = "1" ]; then
        log "WARNING: direct-S3 preflight found note paths missing from Git; WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES=1 allows this live snapshot"
        return 0
    fi

    case "$MAX_S3_ONLY_NOTES" in
        ''|*[!0-9]*)
            log "ERROR: invalid WIKI_SNAPSHOT_MAX_S3_ONLY_NOTES=$MAX_S3_ONLY_NOTES; refusing live snapshot"
            return 1
            ;;
    esac

    if [ "$SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT" -le "$MAX_S3_ONLY_NOTES" ]; then
        log "WARNING: direct-S3 preflight found $SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT note path(s) missing from Git; within limit $MAX_S3_ONLY_NOTES, allowing live snapshot"
        return 0
    fi

    log "ERROR: direct-S3-not-git count exceeds limit: $SNAPSHOT_DIRECT_S3_NOT_GIT_COUNT > $MAX_S3_ONLY_NOTES"
    log "ERROR: Review and promote/delete the S3-only note paths first, raise WIKI_SNAPSHOT_MAX_S3_ONLY_NOTES, or set WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES=1 for an explicitly approved promotion run"
    return 1
}

# ── Guard: --max-delete verification ───────────────────────
# Verify that this script (or a target script) has the --max-delete guard.
# Returns 0 if guard is present, 1 if missing.
wiki_snapshot_assert_guards() {
    local script_path="${1:-$0}"

    if [ ! -f "$script_path" ]; then
        echo "FATAL: snapshot script not found: $script_path" >&2
        return 1
    fi

    if grep -q -- '--max-delete' "$script_path" 2>/dev/null; then
        return 0
    else
        echo "FATAL: --max-delete guard MISSING from $script_path" >&2
        echo "Do NOT run this script on production until the guard is added." >&2
        echo "Reference: raw/transcripts/2026-05-23-bug-sg01-snapshot-destructive-rclone-sync.md" >&2
        return 1
    fi
}

# Self-check: ensure THIS script contains its own --max-delete guard.
if ! wiki_snapshot_assert_guards "$0"; then
    echo "[wiki-snapshot] Self-guard check failed — refusing to run." >&2
    exit 1
fi

# ── Dry-run mode ────────────────────────────────────────────
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [ "$DRY_RUN" = true ]; then
    echo "[wiki-snapshot] DRY RUN"
    echo "  WIKI_DIR          = $WIKI_DIR"
    echo "  SNAPSHOT_WORKTREE = $SNAPSHOT_WORKTREE"
    echo "  LOCK_FILE         = $LOCK_FILE"
    echo "  LOG_FILE          = $LOG_FILE"
    echo "  CLOUD_REMOTE      = $CLOUD_REMOTE"
    echo "  REPAIR_SCRIPT     = $REPAIR_SCRIPT"
    echo "[wiki-snapshot] DRY RUN: --max-delete guard verified (present in $0)"
    dry_run_tmp="$(mktemp -d)" || exit 1
    dry_run_active="$dry_run_tmp/active.paths"
    dry_run_remote="$dry_run_tmp/remote.paths"
    dry_run_plan="$dry_run_tmp/remote-present.paths"
    case "$MAX_TOMBSTONE_PRUNES" in
        ''|*[!0-9]*)
            echo "[wiki-snapshot] ERROR: invalid WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES=$MAX_TOMBSTONE_PRUNES; expected a non-negative integer" >&2
            rm -rf "$dry_run_tmp"
            exit 1
            ;;
    esac
    snapshot_refresh_origin_main 2>/dev/null || true
    snapshot_load_active_delete_intent_paths "$dry_run_active" || : > "$dry_run_active"
    snapshot_direct_s3_preflight "$dry_run_remote" "$dry_run_active" || true
    if [ "$SNAPSHOT_REMOTE_INVENTORY_READY" = "1" ] \
        && delete_intent_plan_remote_paths "$dry_run_active" "$dry_run_remote" > "$dry_run_plan"; then
        dry_run_active_count="$(wc -l < "$dry_run_active" | tr -d ' ')"
        dry_run_remote_count="$(wc -l < "$dry_run_plan" | tr -d ' ')"
        dry_run_absent_count=$((dry_run_active_count - dry_run_remote_count))
        dry_run_deferred_count=0
        if [ "$dry_run_remote_count" -gt "$MAX_TOMBSTONE_PRUNES" ] 2>/dev/null; then
            dry_run_deferred_count=$((dry_run_remote_count - MAX_TOMBSTONE_PRUNES))
        fi
        echo "[wiki-snapshot] DRY RUN: delete-intent active=$dry_run_active_count remote_present=$dry_run_remote_count already_absent=$dry_run_absent_count deferred=$dry_run_deferred_count"
    else
        echo "[wiki-snapshot] DRY RUN: delete-intent remote inventory unavailable; optional pruning would be skipped"
    fi
    rm -rf "$dry_run_tmp"
    echo "[wiki-snapshot] DRY RUN: would acquire $LOCK_FILE, rclone sync, git commit, push."
    echo "[wiki-snapshot] DRY RUN: Complete. No changes made."
    exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

# ── Lock file to prevent concurrent execution ──────────────
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: Another instance of wiki-snapshot is running. Exiting."
    exit 1
fi

# Logging helper
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"
}

snapshot_inhibit_clear() {
    rm -f "$INHIBIT_STATE_FILE" 2>/dev/null || true
}

snapshot_inhibit_read_field() {
    local key="$1"
    [ -f "$INHIBIT_STATE_FILE" ] || return 0
    sed -n "s/^${key}=//p" "$INHIBIT_STATE_FILE" 2>/dev/null | head -1
}

snapshot_inhibit_write() {
    local opid="$1" count="$2" first_seen="$3" last_full="$4" skips="$5"
    local dir
    dir="$(dirname "$INHIBIT_STATE_FILE")"
    mkdir -p "$dir" 2>/dev/null || return 0
    {
        printf 'opid=%s\n' "$opid"
        printf 'count=%s\n' "$count"
        printf 'first_seen=%s\n' "$first_seen"
        printf 'last_full_epoch=%s\n' "$last_full"
        printf 'skips_since_full=%s\n' "$skips"
    } > "$INHIBIT_STATE_FILE" 2>/dev/null || true
}

snapshot_parse_operation_id() {
    local file="$1"
    [ -f "$file" ] || return 0
    sed -n 's/.*"operation_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" 2>/dev/null | head -1
}

snapshot_inhibit_should_skip() {
    local count last_full skips now age
    [ -f "$INHIBIT_STATE_FILE" ] || return 1
    count="$(snapshot_inhibit_read_field count)"
    last_full="$(snapshot_inhibit_read_field last_full_epoch)"
    skips="$(snapshot_inhibit_read_field skips_since_full)"
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    case "$last_full" in ''|*[!0-9]*) last_full=0 ;; esac
    case "$skips" in ''|*[!0-9]*) skips=0 ;; esac
    if [ "$count" -lt "$INHIBIT_AFTER" ]; then
        return 1
    fi
    now="$(date +%s)"
    age=$((now - last_full))
    if [ "$age" -ge "$INHIBIT_RECHECK_SECONDS" ]; then
        return 1
    fi
    if [ "$skips" -ge "$INHIBIT_RECHECK_RUNS" ]; then
        return 1
    fi
    return 0
}

snapshot_inhibit_mark_skip() {
    local opid count first_seen last_full skips
    opid="$(snapshot_inhibit_read_field opid)"
    count="$(snapshot_inhibit_read_field count)"
    first_seen="$(snapshot_inhibit_read_field first_seen)"
    last_full="$(snapshot_inhibit_read_field last_full_epoch)"
    skips="$(snapshot_inhibit_read_field skips_since_full)"
    case "$skips" in ''|*[!0-9]*) skips=0 ;; esac
    skips=$((skips + 1))
    snapshot_inhibit_write "$opid" "$count" "$first_seen" "$last_full" "$skips"
}

snapshot_inhibit_record_failure() {
    local opid="$1"
    local now count first_seen
    [ -n "$opid" ] || return 0
    now="$(date +%s)"
    if [ -f "$INHIBIT_STATE_FILE" ] && [ "$(snapshot_inhibit_read_field opid)" = "$opid" ]; then
        count="$(snapshot_inhibit_read_field count)"
        first_seen="$(snapshot_inhibit_read_field first_seen)"
        case "$count" in ''|*[!0-9]*) count=0 ;; esac
        count=$((count + 1))
        [ -n "$first_seen" ] || first_seen="$now"
    else
        count=1
        first_seen="$now"
    fi
    snapshot_inhibit_write "$opid" "$count" "$first_seen" "$now" 0
}

snapshot_projection_hash_file() {
    local path="${1:-}"
    [ -f "$path" ] || return 1
    local digest
    digest="$(vault_sync_sha256 "$path")"
    [ -n "$digest" ] || return 1
    printf '%s\n' "$digest"
}

validate_projection_parity_config() {
    case "$PROJECTION_PARITY_TIMEOUT_SECONDS" in
        ''|*[!0-9]*)
            log "ERROR: invalid WIKI_SNAPSHOT_PROJECTION_PARITY_TIMEOUT_SECONDS=$PROJECTION_PARITY_TIMEOUT_SECONDS; expected a non-negative integer"
            return 1
            ;;
    esac
    case "$PROJECTION_PARITY_POLL_SECONDS" in
        ''|*[!0-9]*)
            log "ERROR: invalid WIKI_SNAPSHOT_PROJECTION_PARITY_POLL_SECONDS=$PROJECTION_PARITY_POLL_SECONDS; expected a non-negative integer"
            return 1
            ;;
    esac
    case "$PROJECTION_READ_TIMEOUT_SECONDS" in
        ''|*[!0-9]*|0)
            log "ERROR: invalid WIKI_SNAPSHOT_PROJECTION_READ_TIMEOUT_SECONDS=$PROJECTION_READ_TIMEOUT_SECONDS; expected a positive integer"
            return 1
            ;;
    esac
    return 0
}

snapshot_freeze_projection_expectations() {
    if [ "${WIKI_SNAPSHOT_TEST_SKIP_PROJECTION_PARITY:-0}" = "1" ] \
        && [ -n "${SNAPSHOT_TEST_ROOT:-}" ]; then
        log "projection parity guard skipped by test fixture"
        return 0
    fi

    if [ ! -f "$WIKI_DIR/index.md" ] || [ ! -f "$WIKI_DIR/log.md" ]; then
        log "ERROR: live projection files missing after materialization"
        return 1
    fi

    PROJECTION_STATE_DIR="$(mktemp -d)" || {
        log "ERROR: could not create private projection parity state"
        return 1
    }
    if ! cp "$WIKI_DIR/index.md" "$PROJECTION_STATE_DIR/expected-index.md" \
        || ! cp "$WIKI_DIR/log.md" "$PROJECTION_STATE_DIR/expected-log.md"; then
        log "ERROR: could not freeze live projection bytes"
        return 1
    fi

    PROJECTION_EXPECTED_INDEX_SHA256="$(snapshot_projection_hash_file "$PROJECTION_STATE_DIR/expected-index.md")" || return 1
    PROJECTION_EXPECTED_LOG_SHA256="$(snapshot_projection_hash_file "$PROJECTION_STATE_DIR/expected-log.md")" || return 1
    log "projection expected bytes frozen index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 log_sha256=$PROJECTION_EXPECTED_LOG_SHA256"
    return 0
}

snapshot_live_projection_matches_frozen() {
    local live_index_sha live_log_sha
    if ! cmp -s "$PROJECTION_STATE_DIR/expected-index.md" "$WIKI_DIR/index.md" \
        || ! cmp -s "$PROJECTION_STATE_DIR/expected-log.md" "$WIKI_DIR/log.md"; then
        live_index_sha="$(snapshot_projection_hash_file "$WIKI_DIR/index.md" 2>/dev/null || echo unavailable)"
        live_log_sha="$(snapshot_projection_hash_file "$WIKI_DIR/log.md" 2>/dev/null || echo unavailable)"
        log "ERROR: live projection changed after freeze expected_index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 live_index_sha256=$live_index_sha expected_log_sha256=$PROJECTION_EXPECTED_LOG_SHA256 live_log_sha256=$live_log_sha"
        return 1
    fi
    return 0
}

snapshot_wait_for_direct_projection_parity() {
    if [ -z "$PROJECTION_STATE_DIR" ]; then
        # Test-only skip path above. Production always has frozen state.
        return 0
    fi

    local started deadline now attempts
    local remote_index="$PROJECTION_STATE_DIR/remote-index.md"
    local remote_log="$PROJECTION_STATE_DIR/remote-log.md"
    local remote_index_sha="unavailable"
    local remote_log_sha="unavailable"
    local index_pid log_pid index_rc log_rc
    started="$(date +%s)"
    deadline=$((started + PROJECTION_PARITY_TIMEOUT_SECONDS))
    attempts=0

    while :; do
        attempts=$((attempts + 1))
        : > "$remote_index"
        : > "$remote_log"
        timeout "$PROJECTION_READ_TIMEOUT_SECONDS" \
            rclone cat "${CLOUD_REMOTE%/}/index.md" --retries 1 >"$remote_index" 2>>"$LOG_FILE" &
        index_pid=$!
        timeout "$PROJECTION_READ_TIMEOUT_SECONDS" \
            rclone cat "${CLOUD_REMOTE%/}/log.md" --retries 1 >"$remote_log" 2>>"$LOG_FILE" &
        log_pid=$!
        wait "$index_pid"
        index_rc=$?
        wait "$log_pid"
        log_rc=$?
        if [ "$index_rc" -eq 0 ] && [ "$log_rc" -eq 0 ]; then
            if cmp -s "$PROJECTION_STATE_DIR/expected-index.md" "$remote_index" \
                && cmp -s "$PROJECTION_STATE_DIR/expected-log.md" "$remote_log"; then
                if ! snapshot_live_projection_matches_frozen; then
                    return 1
                fi
                remote_index_sha="$(snapshot_projection_hash_file "$remote_index" 2>/dev/null || echo unavailable)"
                remote_log_sha="$(snapshot_projection_hash_file "$remote_log" 2>/dev/null || echo unavailable)"
                log "projection direct-store parity confirmed attempts=$attempts expected_index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 live_index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 remote_index_sha256=$remote_index_sha expected_log_sha256=$PROJECTION_EXPECTED_LOG_SHA256 live_log_sha256=$PROJECTION_EXPECTED_LOG_SHA256 remote_log_sha256=$remote_log_sha"
                return 0
            fi
        fi

        now="$(date +%s)"
        if [ "$now" -ge "$deadline" ]; then
            if [ "$index_rc" -eq 0 ]; then
                remote_index_sha="$(snapshot_projection_hash_file "$remote_index" 2>/dev/null || echo unavailable)"
            fi
            if [ "$log_rc" -eq 0 ]; then
                remote_log_sha="$(snapshot_projection_hash_file "$remote_log" 2>/dev/null || echo unavailable)"
            fi
            log "ERROR: projection direct-store parity timeout attempts=$attempts expected_index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 remote_index_sha256=$remote_index_sha expected_log_sha256=$PROJECTION_EXPECTED_LOG_SHA256 remote_log_sha256=$remote_log_sha"
            return 1
        fi
        sleep "$PROJECTION_PARITY_POLL_SECONDS"
    done
}

snapshot_verify_worktree_projection_parity() {
    if [ -z "$PROJECTION_STATE_DIR" ]; then
        return 0
    fi
    local worktree_index_sha worktree_log_sha
    worktree_index_sha="$(snapshot_projection_hash_file "$SNAPSHOT_WORKTREE/index.md" 2>/dev/null || echo unavailable)"
    worktree_log_sha="$(snapshot_projection_hash_file "$SNAPSHOT_WORKTREE/log.md" 2>/dev/null || echo unavailable)"
    if ! cmp -s "$PROJECTION_STATE_DIR/expected-index.md" "$SNAPSHOT_WORKTREE/index.md" \
        || ! cmp -s "$PROJECTION_STATE_DIR/expected-log.md" "$SNAPSHOT_WORKTREE/log.md"; then
        log "ERROR: projection worktree parity mismatch expected_index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 worktree_index_sha256=$worktree_index_sha expected_log_sha256=$PROJECTION_EXPECTED_LOG_SHA256 worktree_log_sha256=$worktree_log_sha"
        return 1
    fi
    log "projection worktree parity confirmed expected_index_sha256=$PROJECTION_EXPECTED_INDEX_SHA256 worktree_index_sha256=$worktree_index_sha expected_log_sha256=$PROJECTION_EXPECTED_LOG_SHA256 worktree_log_sha256=$worktree_log_sha"
    return 0
}

snapshot_verify_semantic_projection_preview() {
    if [ -z "$PROJECTION_STATE_DIR" ]; then
        return 0
    fi
    local preview="$PROJECTION_STATE_DIR/worktree-preview.json"
    if ! "$SKILLWIKI_BIN" projections materialize "$SNAPSHOT_WORKTREE" >"$preview" 2>>"$LOG_FILE"; then
        log "ERROR: projection semantic preview failed"
        return 1
    fi
    if ! grep -Eq '"index_drift"[[:space:]]*:[[:space:]]*false' "$preview" \
        || ! grep -Eq '"log_drift"[[:space:]]*:[[:space:]]*false' "$preview"; then
        log "ERROR: projection semantic preview mismatch index_or_log_drift=true"
        return 1
    fi
    log "projection semantic preview confirmed index_drift=false log_drift=false"
    return 0
}

snapshot_verify_projection_candidate() {
    snapshot_verify_worktree_projection_parity \
        && snapshot_verify_semantic_projection_preview
}

# Emit the canonical snapshot-completion terminal record (v0.10.14).
# One stable machine-parseable line written for both pushed and no-change
# success outcomes. Failure paths must never call this.
#   SNAPSHOT_COMPLETE schema=v1 outcome=<pushed|no-change> result=success ts=<ISO> head=<oid> origin=<oid|unknown>
emit_snapshot_complete() {
    local outcome="$1"
    local head_oid origin_oid
    if ! snapshot_refresh_origin_main; then
        log "ERROR: could not refresh origin/main for final snapshot proof"
        return 1
    fi
    head_oid="$(git -C "$SNAPSHOT_WORKTREE" rev-parse HEAD 2>/dev/null || echo unknown)"
    origin_oid="$(git -C "$SNAPSHOT_WORKTREE" rev-parse --verify -q origin/main 2>/dev/null || echo unknown)"
    if [ "$head_oid" = "unknown" ] || [ "$origin_oid" = "unknown" ] || [ "$head_oid" != "$origin_oid" ]; then
        log "ERROR: final snapshot proof failed head=$head_oid origin=$origin_oid"
        return 1
    fi
    snapshot_inhibit_clear
    log "SNAPSHOT_COMPLETE schema=v1 outcome=${outcome} result=success ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) head=${head_oid} origin=${origin_oid}"
    return 0
}

snapshot_freeze_git_receipt() {
    local mutation_root convergence_root
    mutation_root="$(cd "$WIKI_DIR" 2>/dev/null && pwd -P)" || return 1
    convergence_root="$(cd "$SNAPSHOT_WORKTREE" 2>/dev/null && pwd -P)" || return 1
    SNAPSHOT_GIT_DIR="$(git -C "$SNAPSHOT_WORKTREE" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
    SNAPSHOT_GIT_COMMON_DIR="$(git -C "$SNAPSHOT_WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
    SNAPSHOT_BASE_OID="$(git -C "$SNAPSHOT_WORKTREE" rev-parse HEAD 2>/dev/null)" || return 1
    log "snapshot transaction receipt mutation_root=$mutation_root convergence_root=$convergence_root git_dir=$SNAPSHOT_GIT_DIR git_common_dir=$SNAPSHOT_GIT_COMMON_DIR base_oid=$SNAPSHOT_BASE_OID write_mode=dual-path-snapshot"
    return 0
}

snapshot_verify_git_receipt() {
    local current_git_dir current_common_dir current_head
    current_git_dir="$(git -C "$SNAPSHOT_WORKTREE" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
    current_common_dir="$(git -C "$SNAPSHOT_WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
    current_head="$(git -C "$SNAPSHOT_WORKTREE" rev-parse HEAD 2>/dev/null)" || return 1
    if [ "$current_git_dir" != "$SNAPSHOT_GIT_DIR" ] \
        || [ "$current_common_dir" != "$SNAPSHOT_GIT_COMMON_DIR" ] \
        || [ "$current_head" != "$SNAPSHOT_BASE_OID" ]; then
        log "ERROR: snapshot transaction receipt drift expected_base_oid=$SNAPSHOT_BASE_OID actual_base_oid=$current_head"
        return 1
    fi
    return 0
}

validate_tombstone_prune_cap() {
    case "$MAX_TOMBSTONE_PRUNES" in
        ''|*[!0-9]*)
            log "ERROR: invalid WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES=$MAX_TOMBSTONE_PRUNES; expected a non-negative integer"
            return 1
            ;;
    esac
    return 0
}

raw_dedup_guard() {
    if [ "${WIKI_SNAPSHOT_RAW_DEDUP_GUARD:-1}" = "0" ]; then
        log "raw_dedup guard skipped by WIKI_SNAPSHOT_RAW_DEDUP_GUARD=0"
        return 0
    fi

    SKILLWIKI_BIN="${WIKI_SNAPSHOT_SKILLWIKI_BIN:-skillwiki}"
    if ! command -v "$SKILLWIKI_BIN" >/dev/null 2>&1; then
        log "ERROR: skillwiki CLI unavailable; refusing to commit snapshot without raw_dedup guard"
        return 1
    fi

    GUARD_LOG="${RCLONE_LOG}.raw-dedup-guard"
    if ! "$SKILLWIKI_BIN" lint "$SNAPSHOT_WORKTREE" --only raw_dedup --summary >"$GUARD_LOG" 2>&1; then
        log "ERROR: raw_dedup guard failed after cloud sync; refusing to commit snapshot"
        cat "$GUARD_LOG" >>"$LOG_FILE" 2>/dev/null || true
        rm -f "$GUARD_LOG"
        return 1
    fi

    rm -f "$GUARD_LOG"
    log "raw_dedup guard passed"
    return 0
}

conflict_marker_guard() {
    if [ "${WIKI_SNAPSHOT_CONFLICT_MARKER_GUARD:-1}" = "0" ]; then
        log "conflict-marker guard skipped by WIKI_SNAPSHOT_CONFLICT_MARKER_GUARD=0"
        return 0
    fi

    local findings
    findings="$(mktemp)" || { log "ERROR: could not create conflict-marker scan temp file"; return 1; }
    if ! vault_sync_scan_conflict_markers "$SNAPSHOT_WORKTREE" "$findings"; then
        log "ERROR: conflict marker blocks found after cloud sync; refusing to commit snapshot"
        vault_sync_log_conflict_marker_findings "$findings" "$LOG_FILE"
        rm -f "$findings"
        return 1
    fi
    rm -f "$findings"
    log "conflict-marker guard passed"
    return 0
}

refresh_git_baseline() {
    (
        cd "$SNAPSHOT_WORKTREE" || exit 1
        fetch_origin_main_ref 2>/dev/null || exit 2

        if [ -n "$(git status --porcelain)" ]; then
            exit 3
        fi

        if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
            if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
                git merge --ff-only origin/main >/dev/null
                exit 4
            fi
            exit 0
        fi

        exit 5
    )
    local rc=$?
    case "$rc" in
        0) return 0 ;;
        4) log "Git baseline fast-forwarded to origin/main before S3 sync"; return 0 ;;
        2) log "WARNING: Could not fetch origin/main before S3 sync; continuing with existing refs"; return 0 ;;
        3) log "WARNING: Snapshot worktree dirty before S3 sync; skipping baseline fast-forward"; return 0 ;;
        5) log "WARNING: Snapshot worktree is not an ancestor of origin/main; repair step will handle it after S3 sync"; return 0 ;;
        *) log "WARNING: Git baseline refresh failed rc=$rc; continuing"; return 0 ;;
    esac
}

log "=== Wiki Snapshot: $DATE ==="

if ! validate_tombstone_prune_cap; then
    exit 1
fi
if ! validate_projection_parity_config; then
    exit 1
fi

# Check disk space (need at least 100MB free)
AVAILABLE_KB=$(df -k "$SNAPSHOT_WORKTREE" | awk 'NR==2 {print $4}')
if [ "$AVAILABLE_KB" -lt 102400 ]; then
    log "ERROR: Insufficient disk space. Only ${AVAILABLE_KB}KB available, need 100MB."
    exit 1
fi

# Check repository validity through Git so linked worktrees (.git text files)
# are accepted and Git-internal paths are resolved from the convergence root.
if [ "$(git -C "$SNAPSHOT_WORKTREE" rev-parse --is-inside-work-tree 2>/dev/null)" != "true" ]; then
    log "ERROR: Git worktree not found or not a git repo: $SNAPSHOT_WORKTREE"
    exit 1
fi

refresh_git_baseline

# Dual-path requires distinct live mutation vs Git convergence roots.
# Same-path would materialize projections then immediately rclone-overwrite them.
if [ "$(cd "$WIKI_DIR" 2>/dev/null && pwd -P)" = "$(cd "$SNAPSHOT_WORKTREE" 2>/dev/null && pwd -P)" ]; then
    log "ERROR: WIKI_DIR and WIKI_GIT_WORKTREE must be distinct paths for dual-path projection (got: $WIKI_DIR)"
    exit 1
fi
if ! snapshot_freeze_git_receipt; then
    log "ERROR: could not freeze snapshot transaction receipt"
    exit 1
fi

if snapshot_inhibit_should_skip; then
    snapshot_inhibit_mark_skip
    log "SNAPSHOT_INHIBITED schema=v1 opid=$(snapshot_inhibit_read_field opid) count=$(snapshot_inhibit_read_field count) first_seen=$(snapshot_inhibit_read_field first_seen)"
    exit 1
fi

# Single-authority root projections before FUSE/S3 pull promotion.
# Mutation target is the live vault ($WIKI_DIR); Git pull/base-OID use
# $SNAPSHOT_WORKTREE so FUSE/S3 hosts without a local Git HEAD still work.
SKILLWIKI_BIN="${WIKI_SNAPSHOT_SKILLWIKI_BIN:-skillwiki}"
if command -v "$SKILLWIKI_BIN" >/dev/null 2>&1; then
    case "${WIKI_SNAPSHOT_MIGRATE_LEGACY:-0}" in
        0) ;;
        1)
            if ! "$SKILLWIKI_BIN" log migrate-legacy "$WIKI_DIR" --write \
                --converge-vault "$SNAPSHOT_WORKTREE" >>"$LOG_FILE" 2>&1; then
                log "FAIL legacy log migration; snapshot promotion refused"
                exit 1
            fi
            log "OK legacy log migration before projection (attended one-run)"
            ;;
        *)
            log "ERROR: WIKI_SNAPSHOT_MIGRATE_LEGACY must be 0 or 1 (got: ${WIKI_SNAPSHOT_MIGRATE_LEGACY})"
            exit 1
            ;;
    esac
    proj_out="$(mktemp)"
    if ! "$SKILLWIKI_BIN" projections materialize "$WIKI_DIR" --write \
        --converge-vault "$SNAPSHOT_WORKTREE" >"$proj_out" 2>&1; then
        cat "$proj_out" >>"$LOG_FILE" 2>/dev/null || true
        snapshot_inhibit_record_failure "$(snapshot_parse_operation_id "$proj_out")"
        rm -f "$proj_out"
        log "FAIL root projection materialization; snapshot promotion refused"
        exit 1
    fi
    cat "$proj_out" >>"$LOG_FILE" 2>/dev/null || true
    rm -f "$proj_out"
    log "OK projections materialize before snapshot sync"
    if ! snapshot_freeze_projection_expectations; then
        log "FAIL projection expectation freeze; snapshot promotion refused"
        exit 1
    fi
    if ! snapshot_wait_for_direct_projection_parity; then
        log "FAIL projection direct-store parity; snapshot promotion refused"
        exit 1
    fi
else
    log "ERROR: skillwiki CLI unavailable; refusing snapshot without projection materialization and parity proof"
    exit 1
fi

# Common rclone options
# NOTE: rclone sync already deletes by default; exclusions prevent .git deletion
RCLONE_OPTS=(
    --exclude ".snapshots/**"
    --exclude ".git/**"
    --exclude ".obsidian/**"
    --exclude ".skillwiki/**"
    --exclude ".claude/**"
    --exclude ".antigravitycli/**"
    --exclude ".playwright-cli/**"
    --exclude "._*"
    --exclude ".conflict*"
    --exclude "*.conflict-*"
    --checksum
    --transfers 8
    --checkers 16
    --fast-list
    --timeout 5m
    --contimeout 1m
    --max-delete 10
)

if ! handle_direct_s3_preflight_before_sync; then
    exit 1
fi

# Sync from cloud directly to git dir using rclone
echo "Syncing from cloud to git repo (via rclone)..."

if ! rclone sync "$CLOUD_REMOTE" "$SNAPSHOT_WORKTREE" "${RCLONE_OPTS[@]}" --stats 10s 2>&1 | tee "$RCLONE_LOG"; then
    RCLONE_EXIT=$?
    log "ERROR: Rclone sync failed with exit code $RCLONE_EXIT"
    log "Last 50 lines of output:"
    tail -50 "$RCLONE_LOG" >> "$LOG_FILE" 2>/dev/null || true
    rm -f "$RCLONE_LOG"
    exit 1
fi

rm -f "$RCLONE_LOG"

# Verify sync actually happened
if [ ! -f "$SNAPSHOT_WORKTREE/index.md" ]; then
    log "ERROR: Sync verification failed - index.md not found in git dir"
    exit 1
fi

# --- Delete-intent no-resurrect ---
# Git is SSOT for intentional absences. After S3→worktree sync, strip any path
# that has an active tombstone on origin/main and optionally prune S3.
snapshot_remote_path_exists_exact() {
    local rel_path="${1:-}"
    local parent_path base_name remote_parent output_file rc
    [ -n "$rel_path" ] || return 2

    base_name="${rel_path##*/}"
    if [ "$rel_path" = "$base_name" ]; then
        remote_parent="${CLOUD_REMOTE%/}"
    else
        parent_path="${rel_path%/*}"
        remote_parent="${CLOUD_REMOTE%/}/$parent_path"
    fi

    output_file="$(mktemp)" || return 2
    if ! rclone lsf "$remote_parent" --files-only --max-depth 1 --retries 1 > "$output_file" 2>>"$LOG_FILE"; then
        rm -f "$output_file"
        return 2
    fi
    if grep -Fxq -- "$base_name" "$output_file"; then
        rc=0
    else
        rc=1
    fi
    rm -f "$output_file"
    return "$rc"
}

snapshot_apply_delete_intents() {
    local paths_file="${1:-}"
    local remote_inventory_file="${2:-}"
    local inventory_ready="${3:-0}"
    if [ ! -f "$paths_file" ]; then
        log "ERROR: active delete-intent inventory file missing; refusing snapshot promotion"
        return 1
    fi

    if [ ! -s "$paths_file" ]; then
        log "delete-intent: no active tombstones"
        return 0
    fi

    # Re-materialize ledger from git so rclone sync cannot drop git-only intents,
    # and fail closed if the authoritative ledger cannot be restored.
    if ! (
        cd "$SNAPSHOT_WORKTREE" || exit 1
        if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
            git checkout origin/main -- meta/delete-intents/
        fi
    ) 2>>"$LOG_FILE"; then
        log "ERROR: could not restore authoritative delete-intent ledger from origin/main"
        return 1
    fi

    local active_count remote_present_count attempted pruned already_absent failed deferred
    local rel_path plan_file recheck_rc
    active_count="$(wc -l < "$paths_file" | tr -d ' ')"
    remote_present_count=0
    attempted=0
    pruned=0
    already_absent=0
    failed=0
    deferred=0

    while IFS= read -r rel_path; do
        [ -z "$rel_path" ] && continue
        if [ -e "$SNAPSHOT_WORKTREE/$rel_path" ]; then
            rm -f -- "$SNAPSHOT_WORKTREE/$rel_path"
            log "delete-intent: stripped resurrected path from worktree: $rel_path"
        fi
    done < "$paths_file"

    if [ "$inventory_ready" != "1" ] || [ ! -f "$remote_inventory_file" ]; then
        log "WARNING: delete-intent remote inventory unavailable; optional S3 pruning skipped"
        log "delete-intent: no-resurrect pass complete active=$active_count inventory_ready=0 remote_present=0 attempted=0 pruned=0 already_absent=0 failed=0 deferred=0"
        return 0
    fi

    plan_file="$(mktemp)" || {
        log "WARNING: could not create delete-intent prune plan; optional S3 pruning skipped"
        return 0
    }
    if ! delete_intent_plan_remote_paths "$paths_file" "$remote_inventory_file" > "$plan_file"; then
        rm -f "$plan_file"
        log "WARNING: could not plan delete-intent remote intersection; optional S3 pruning skipped"
        return 0
    fi

    remote_present_count="$(wc -l < "$plan_file" | tr -d ' ')"
    already_absent=$((active_count - remote_present_count))

    while IFS= read -r rel_path; do
        [ -z "$rel_path" ] && continue
        if [ "$attempted" -ge "$MAX_TOMBSTONE_PRUNES" ]; then
            break
        fi
        attempted=$((attempted + 1))
        if rclone deletefile "${CLOUD_REMOTE%/}/$rel_path" --retries 1 >>"$LOG_FILE" 2>&1; then
            pruned=$((pruned + 1))
            log "delete-intent: pruned S3 object $rel_path"
            continue
        fi

        snapshot_remote_path_exists_exact "$rel_path"
        recheck_rc=$?
        if [ "$recheck_rc" -eq 1 ]; then
            already_absent=$((already_absent + 1))
            log "delete-intent: delete race resolved as already absent: $rel_path"
        elif [ "$recheck_rc" -eq 0 ]; then
            failed=$((failed + 1))
            log "WARNING: delete-intent prune failed and object remains present: $rel_path"
        else
            failed=$((failed + 1))
            log "WARNING: delete-intent prune failed and exact recheck was unavailable: $rel_path"
        fi
    done < "$plan_file"

    deferred=$((remote_present_count - attempted))
    rm -f "$plan_file"
    log "delete-intent: no-resurrect pass complete active=$active_count inventory_ready=1 remote_present=$remote_present_count attempted=$attempted pruned=$pruned already_absent=$already_absent failed=$failed deferred=$deferred"
    return 0
}

snapshot_reconcile_delete_intents() {
    local tmp_dir active_paths remote_inventory rc
    tmp_dir="$(mktemp -d)" || {
        log "ERROR: could not create delete-intent reconciliation state"
        return 1
    }
    active_paths="$tmp_dir/active.paths"
    remote_inventory="$tmp_dir/remote.paths"

    if ! snapshot_refresh_origin_main 2>/dev/null; then
        log "WARNING: could not refresh origin/main before delete-intent reconciliation; using the existing ref"
    fi
    if ! snapshot_load_active_delete_intent_paths "$active_paths"; then
        rm -rf "$tmp_dir"
        log "ERROR: could not load active delete-intent paths; refusing snapshot promotion"
        return 1
    fi

    snapshot_direct_s3_preflight "$remote_inventory" "$active_paths" || true
    snapshot_apply_delete_intents "$active_paths" "$remote_inventory" "$SNAPSHOT_REMOTE_INVENTORY_READY"
    rc=$?
    rm -rf "$tmp_dir"
    return "$rc"
}

if ! snapshot_reconcile_delete_intents; then
    exit 1
fi
if ! snapshot_verify_projection_candidate; then
    log "FAIL projection candidate verification; snapshot promotion refused"
    exit 1
fi

# Change to git dir for operations
cd "$SNAPSHOT_WORKTREE" || { log "ERROR: Failed to cd to $SNAPSHOT_WORKTREE"; exit 1; }

# Configure git if not already set
git config user.email "snapshot@vault-sync.local" 2>/dev/null || true
git config user.name "Vault Sync Snapshot" 2>/dev/null || true

if command -v git_case_assert_clean >/dev/null 2>&1; then
    if ! CASE_CONFLICTS=$(git_case_conflicts); then
        log "ERROR: Case-only path collision detected; refusing to commit snapshot"
        printf '%s\n' "$CASE_CONFLICTS" | tee -a "$LOG_FILE"
        exit 1
    fi
else
    log "ERROR: git-case helper unavailable; refusing to commit snapshot"
    exit 1
fi

# Check if git is in broken state (rebase in progress, merge conflicts, diverged)
needs_repair=false

# Check for rebase/merge in progress
if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ] || [ -f ".git/MERGE_HEAD" ]; then
    log "WARNING: Git rebase/merge in progress - needs repair"
    needs_repair=true
fi

# Check for unmerged files
if git diff --name-only --diff-filter=U | grep -q . 2>/dev/null; then
    log "WARNING: Merge conflicts detected - needs repair"
    needs_repair=true
fi

# Check if we're in detached HEAD state
if ! git symbolic-ref -q HEAD >/dev/null 2>&1; then
    log "WARNING: Detached HEAD state - needs repair"
    needs_repair=true
fi

# Check if we can fast-forward to origin
DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $3}')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}

if ! git merge-base --is-ancestor HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null; then
    # Local HEAD is not an ancestor of origin - diverged
    log "WARNING: Diverged from origin/$DEFAULT_BRANCH - needs repair"
    needs_repair=true
fi

# Repair if needed
if [ "$needs_repair" = true ]; then
    log "Running git repair..."
    if ! bash "$REPAIR_SCRIPT" 2>&1 | tee -a "$LOG_FILE"; then
        log "ERROR: Git repair failed"
        exit 1
    fi
    cd "$SNAPSHOT_WORKTREE" || { log "ERROR: Failed to cd to $SNAPSHOT_WORKTREE after repair"; exit 1; }

    # Re-run rclone sync after repair to ensure we have latest
    if ! rclone sync "$CLOUD_REMOTE" "$SNAPSHOT_WORKTREE" "${RCLONE_OPTS[@]}" --stats 10s 2>&1 | tee "$RCLONE_LOG"; then
        log "ERROR: Post-repair rclone sync failed"
        tail -50 "$RCLONE_LOG" >> "$LOG_FILE" 2>/dev/null || true
        rm -f "$RCLONE_LOG"
        exit 1
    fi
    rm -f "$RCLONE_LOG"
    if ! snapshot_reconcile_delete_intents; then
        exit 1
    fi
    if ! snapshot_verify_projection_candidate; then
        log "FAIL post-repair projection candidate verification; snapshot promotion refused"
        exit 1
    fi
    if ! snapshot_freeze_git_receipt; then
        log "ERROR: could not refresh snapshot transaction receipt after repair"
        exit 1
    fi
fi

if ! raw_dedup_guard; then
    exit 1
fi

if ! conflict_marker_guard; then
    exit 1
fi

# Check for changes
if [ -z "$(git status --porcelain)" ]; then
    log "No changes to commit"
    if ! snapshot_verify_git_receipt; then
        log "ERROR: snapshot transaction changed before no-change proof"
        exit 1
    fi
    if ! emit_snapshot_complete "no-change"; then
        exit 1
    fi
    exit 0
fi

# Re-check immediately before staging because rclone/repair may have changed the
# tree after the first guard.
if command -v git_case_assert_clean >/dev/null 2>&1; then
    if ! CASE_CONFLICTS=$(git_case_conflicts); then
        log "ERROR: Case-only path collision detected before git add; refusing to commit snapshot"
        printf '%s\n' "$CASE_CONFLICTS" | tee -a "$LOG_FILE"
        exit 1
    fi
fi

# The commit candidate may modify worktree bytes, but it must not silently move
# the convergence repository or HEAD away from the frozen transaction base.
if ! snapshot_verify_git_receipt; then
    log "ERROR: snapshot transaction changed before staging"
    exit 1
fi

# Commit
echo "Committing changes..."
if ! git add -A; then
    log "ERROR: git add failed"
    exit 1
fi

if ! git commit -m "Snapshot $DATE"; then
    log "ERROR: git commit failed"
    exit 1
fi

# Pull with rebase to get any remote changes (with retry)
echo "Pulling from origin..."
PULL_RETRIES=3
PULL_SUCCESS=false

for i in $(seq 1 $PULL_RETRIES); do
    if git pull --rebase origin "$DEFAULT_BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
        PULL_SUCCESS=true
        break
    fi
    log "WARNING: Pull attempt $i failed, retrying..."
    sleep 5
done

if [ "$PULL_SUCCESS" = false ]; then
    log "ERROR: Pull failed after $PULL_RETRIES attempts - attempting repair"
    if bash "$REPAIR_SCRIPT" 2>&1 | tee -a "$LOG_FILE"; then
        # After repair, commit timestamp will be slightly different
        DATE=$(date +%Y%m%d_%H%M%S)
        cd "$SNAPSHOT_WORKTREE" || { log "ERROR: Failed to cd after repair"; exit 1; }

        # Re-sync after repair
        rclone sync "$CLOUD_REMOTE" "$SNAPSHOT_WORKTREE" "${RCLONE_OPTS[@]}" 2>&1 | tee -a "$LOG_FILE" || true
        if ! raw_dedup_guard || ! conflict_marker_guard; then
            exit 1
        fi
        git add -A || true
        git commit -m "Snapshot $DATE (post-repair)" || true
    else
        log "ERROR: Repair failed after pull failure"
        exit 1
    fi
fi

# Push (with retry)
echo "Pushing to origin..."
PUSH_RETRIES=3
PUSH_SUCCESS=false

for i in $(seq 1 $PUSH_RETRIES); do
    if git push origin "$DEFAULT_BRANCH" 2>&1 | tee -a "$LOG_FILE"; then
        PUSH_SUCCESS=true
        break
    fi
    log "WARNING: Push attempt $i failed, retrying..."
    sleep 5
done

if [ "$PUSH_SUCCESS" = true ]; then
    log "Push successful"
    log "Status: complete"
    if ! emit_snapshot_complete "pushed"; then
        exit 1
    fi
    exit 0
else
    log "ERROR: Push failed after $PUSH_RETRIES attempts"
    # Run repair for next attempt
    bash "$REPAIR_SCRIPT" 2>&1 | tee -a "$LOG_FILE" || true
    exit 1
fi
