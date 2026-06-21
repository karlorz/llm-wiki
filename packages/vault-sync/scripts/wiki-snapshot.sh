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

# ── Guard: Linux-only operation ────────────────────────────
platform_require linux

# ── Path configuration (env-overridable for plugin portability) ─
WIKI_DIR="${WIKI_DIR:-/root/wiki}"
SNAPSHOT_WORKTREE="${WIKI_GIT_WORKTREE:-${SNAPSHOT_WORKTREE:-/root/wiki-git}}"
LOCK_FILE="${WIKI_SNAPSHOT_LOCK:-/var/lock/wiki-snapshot.lock}"
DEFAULT_LOG_DIR="$(platform_log_dir)"
LOG_FILE="${WIKI_SNAPSHOT_LOG:-$DEFAULT_LOG_DIR/wiki-snapshot.log}"
CLOUD_REMOTE="${CLOUD_REMOTE:-cloud:cloud/wiki}"
REPAIR_SCRIPT="${WIKI_GIT_REPAIR_SCRIPT:-$SCRIPT_DIR/wiki-git-repair-v3.sh}"
DATE=$(date +%Y%m%d_%H%M%S)
RCLONE_LOG="/tmp/rclone-${DATE}.log"

snapshot_direct_s3_preflight() {
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    local direct_paths="$tmp_dir/direct-s3.paths"
    local direct_notes="$tmp_dir/direct-s3-notes.paths"
    local git_paths="$tmp_dir/git.paths"
    local direct_not_git="$tmp_dir/direct-s3-not-git.paths"

    if ! rclone lsf "$CLOUD_REMOTE" --recursive --files-only 2>/dev/null | LC_ALL=C sort > "$direct_paths"; then
        echo "[wiki-snapshot] WARN: direct-S3 preflight could not list $CLOUD_REMOTE"
        rm -rf "$tmp_dir"
        return 0
    fi

    grep -vE '^(\.skillwiki/|\.claude/|\.obsidian/|\.antigravitycli/|raw/\._\.DS_Store$|\._\.DS_Store$)' "$direct_paths" > "$direct_notes" || true
    (
        cd "$SNAPSHOT_WORKTREE" || exit 1
        find . -type f ! -path "./.git/*" | sed 's#^\./##' | LC_ALL=C sort
    ) > "$git_paths" 2>/dev/null || {
        echo "[wiki-snapshot] WARN: direct-S3 preflight could not list snapshot worktree $SNAPSHOT_WORKTREE"
        rm -rf "$tmp_dir"
        return 0
    }

    comm -23 "$direct_notes" "$git_paths" > "$direct_not_git"
    local count
    count="$(wc -l < "$direct_not_git" | tr -d ' ')"
    if [ "$count" != "0" ]; then
        echo "[wiki-snapshot] WARN: direct-S3-not-git warning: $count note path(s) exist in direct S3 but not in $SNAPSHOT_WORKTREE"
        sed -n '1,20p' "$direct_not_git" | sed 's/^/[wiki-snapshot] WARN: direct-S3-not-git: /'
        rm -rf "$tmp_dir"
        return 2
    fi

    rm -rf "$tmp_dir"
    return 0
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
    snapshot_direct_s3_preflight || true
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

log "=== Wiki Snapshot: $DATE ==="

# Check disk space (need at least 100MB free)
AVAILABLE_KB=$(df -k "$SNAPSHOT_WORKTREE" | awk 'NR==2 {print $4}')
if [ "$AVAILABLE_KB" -lt 102400 ]; then
    log "ERROR: Insufficient disk space. Only ${AVAILABLE_KB}KB available, need 100MB."
    exit 1
fi

# Check if git directory exists
if [ ! -d "$SNAPSHOT_WORKTREE/.git" ]; then
    log "ERROR: Git worktree not found or not a git repo: $SNAPSHOT_WORKTREE"
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

if ! snapshot_direct_s3_preflight; then
    if [ "${WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES:-0}" = "1" ]; then
        log "WARNING: direct-S3 preflight found note paths missing from Git; WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES=1 allows this live snapshot"
    else
        log "ERROR: direct-S3 preflight found note paths missing from Git; refusing live snapshot before rclone sync"
        log "ERROR: Review and promote/delete the S3-only note paths first, or set WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES=1 for an explicitly approved promotion run"
        exit 1
    fi
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

snapshot_direct_s3_preflight || true

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
fi

if ! raw_dedup_guard; then
    exit 1
fi

# Check for changes
if [ -z "$(git status --porcelain)" ]; then
    log "No changes to commit"
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
    exit 0
else
    log "ERROR: Push failed after $PUSH_RETRIES attempts"
    # Run repair for next attempt
    bash "$REPAIR_SCRIPT" 2>&1 | tee -a "$LOG_FILE" || true
    exit 1
fi
