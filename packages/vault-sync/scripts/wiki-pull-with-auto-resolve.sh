#!/bin/bash
# wiki-pull-with-auto-resolve.sh — git pull --rebase with archive-commit conflict storm
# auto-resolution.
#
# When git pull --rebase hits content conflicts on archive-only commits
# (message matches "^archive: moved"), auto-resolve all conflicts with
# --ours (keep HEAD) and continue. Non-archive conflicts are left for
# manual resolution.
#
# Append-only log.md conflicts (root log.md or any */log.md) are union-merged
# via `git merge-file --union` so concurrent appends on both sides are
# preserved without wedging the unattended pull. This runs before the
# archive-commit check, so log.md conflicts on archive/snapshot commits are
# also union-merged (append-only logs benefit from union, not --ours). If any
# conflicted path is not a log.md, the union resolver declines and the
# archive/manual branch handles the full set. A rebase iteration cap
# (MAX_REBASE_ITERS) prevents a silent resolver failure from spinning forever.
#
# Before pull, stale-clean sequencer state is cleared with recovery-ref +
# `git rebase --quit` (never abort). Fully materialized local commits (content
# already present on the remote tip) may be dropped from the rebase todo.
#
# Convergence uses a frozen TARGET_OID from the post-fetch tip. On a non-archive
# manual conflict the helper may retry once if the remote advanced while the
# conflict identity is still owned/unmutated; otherwise it fails closed with
# handoff=1 (review-required). Later runs refuse to reclaim handoff rebases.
#
# Force-push guard: this helper never publishes to a remote. Do not add
# non-fast-forward push flags here. If a publish path is added later,
# require merge-base ancestry of the remote tip before a plain push.

#
# Usage:
#   wiki-pull-with-auto-resolve.sh [--remote <name>] [--branch <name>]
#   Defaults: origin, main

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
. "$SCRIPT_DIR/lib/platform.sh"
. "$SCRIPT_DIR/lib/lockfile.sh"
. "$SCRIPT_DIR/lib/git-case.sh"
. "$SCRIPT_DIR/lib/conflict-markers.sh"
. "$SCRIPT_DIR/lib/git-rebase-state.sh"
. "$SCRIPT_DIR/lib/git-materialization.sh"
. "$SCRIPT_DIR/lib/git-operation-journal.sh"
. "$SCRIPT_DIR/lib/managed-write-lock.sh"
platform_detect_os

WIKI_DIR="${WIKI_DIR:-$HOME/wiki}"
REMOTE="${1:-origin}"
BRANCH="${2:-main}"
LOG_FILE="$(platform_log_dir)/wiki-pull.log"
# Vault-scoped cooperative lock so concurrent pulls on the same vault fail closed.
WIKI_DIR_HASH="$(printf '%s' "$WIKI_DIR" | shasum -a 256 2>/dev/null | cut -c1-16)"
if [ -z "$WIKI_DIR_HASH" ]; then
  WIKI_DIR_HASH="$(printf '%s' "$WIKI_DIR" | cksum | awk '{print $1}')"
fi
LOCK_FILE="$(platform_cache_dir)/wiki-pull.${WIKI_DIR_HASH}.lock"
LOCK_HELD=0

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$LOCK_FILE")"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"; }

release_pull_lock() {
  if [ "${LOCK_HELD:-0}" = "1" ] && [ -n "${LOCK_FILE:-}" ]; then
    lockfile_release "$LOCK_FILE"
    LOCK_HELD=0
  fi
}

# Always release cooperative lock and owned managed-write lock on exit.
# INT/TERM re-enter via EXIT so SIGKILL-only gaps are handled by dead-owner
# reclaim on the next acquire (see managed-write-lock.sh).
vault_sync_pull_cleanup() {
  release_pull_lock
  vault_sync_managed_lock_release || true
}
trap vault_sync_pull_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

acquire_pull_lock() {
  local lock_rc=0
  lockfile_acquire "$LOCK_FILE" 600 || lock_rc=$?
  if [ "$lock_rc" -eq 1 ]; then
    log "FAIL pull lock contention path=$LOCK_FILE"
    echo "FAIL: another wiki-pull is in flight for this vault (lock=$LOCK_FILE)" >&2
    return 1
  fi
  if [ "$lock_rc" -eq 2 ]; then
    log "stale pull lock reclaimed path=$LOCK_FILE"
  fi
  LOCK_HELD=1
  return 0
}

drop_or_preserve_untracked_remote_overlaps() {
    local removed=0
    local preserved=0
    local path remote_blob
    local collision_root backup_path backup_dir

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
            if [ -z "${collision_root:-}" ]; then
                collision_root="$(platform_cache_dir)/untracked-collisions/$(date -u +%Y%m%dT%H%M%SZ)-$$"
            fi
            backup_path="$collision_root/$path"
            backup_dir="$(dirname "$backup_path")"
            if ! mkdir -p "$backup_dir" || ! cp -p "$path" "$backup_path"; then
                log "FAIL could not preserve divergent untracked remote overlap before pull: $path"
                return 1
            fi
            if rm -f -- "$path"; then
                preserved=$((preserved + 1))
                log "PRESERVE divergent untracked remote overlap before pull: $path -> $backup_path"
            else
                log "FAIL could not remove preserved divergent untracked remote overlap before pull: $path"
                return 1
            fi
        fi
        rm -f "$remote_blob"
    done < <(git ls-files --others --exclude-standard -z)

    if [ "$removed" -gt 0 ]; then
        log "DROP $removed identical untracked remote duplicate(s) before pull"
    fi
    if [ "$preserved" -gt 0 ]; then
        log "PRESERVE $preserved divergent untracked remote overlap(s) before pull"
    fi
    return 0
}

is_log_conflict_path() {
    case "$1" in
        log.md|*/log.md) return 0 ;;
        *) return 1 ;;
    esac
}

# Roll back paths already staged by an in-progress union resolve so a later
# archive/manual resolve branch starts from a clean, fully-conflicted state.
# `git checkout --conflict=merge` re-creates the UU state (all 3 index stages)
# in both index and worktree, undoing a prior `git add`. Best-effort — errors
# are logged, not fatal.
rollback_resolved() {
    local arr_name="$1[@]"
    local p
    for p in "${!arr_name}"; do
        if ! git checkout --conflict=merge -- "$p" 2>/dev/null; then
            git restore --staged -- "$p" 2>/dev/null || log "WARN rollback could not restore conflict state: $p"
        fi
    done
}

verify_no_tracked_conflict_markers() {
    local matches
    matches="$(mktemp)" || { log "FAIL could not create conflict-marker scan temp file"; return 1; }
    if ! vault_sync_scan_conflict_markers "$WIKI_DIR" "$matches"; then
        log "FAIL unresolved conflict marker blocks remain after pull"
        vault_sync_log_conflict_marker_findings "$matches" "$LOG_FILE"
        rm -f "$matches"
        return 1
    fi
    rm -f "$matches"
    return 0
}

# Composite derived-artifact resolver (log, root index, project index, taxonomy).
# Delegates the complete conflict set to skillwiki sync resolve-derived; no
# blanket checkout --ours for archive/snapshot mixed sets.
try_auto_resolve_derived_conflicts() {
    local op_id="$1"
    local cli_ts="${SCRIPT_DIR}/../../cli/src/cli.ts"
    local cmd_rc=1
    if [ -z "$op_id" ]; then
        return 1
    fi
    # Prefer monorepo CLI when present (packaged install uses adjacent dist later).
    if [ -f "$cli_ts" ] && command -v npx >/dev/null 2>&1; then
        if VAULT_SYNC_OPERATION_ID="$op_id" \
          npx --yes tsx "$cli_ts" sync resolve-derived "$WIKI_DIR" --operation-id "$op_id" >>"$LOG_FILE" 2>&1; then
            log "AUTO-RESOLVE composite derived artifacts op=$op_id"
            return 0
        fi
        cmd_rc=$?
        log "WARN monorepo resolve-derived failed rc=$cmd_rc op=$op_id"
    fi
    if command -v skillwiki >/dev/null 2>&1; then
        if VAULT_SYNC_OPERATION_ID="$op_id" \
          skillwiki sync resolve-derived "$WIKI_DIR" --operation-id "$op_id" >>"$LOG_FILE" 2>&1; then
            log "AUTO-RESOLVE composite derived artifacts op=$op_id (skillwiki)"
            return 0
        fi
    fi
    return 1
}

# Build a temporary sequence editor that drops fully materialized commits.
prepare_materialization_sequence_editor() {
    local drop_list="$1"
    local editor_script="$2"
    cat > "$editor_script" <<EOF
#!/bin/bash
set -u
DROP_LIST="$drop_list"
LIB="$SCRIPT_DIR/lib/git-materialization.sh"
. "\$LIB"
vault_sync_sequence_editor_drop "\$DROP_LIST" "\$1"
EOF
    chmod +x "$editor_script"
}

# Rebase onto an exact frozen OID (not a moving symbolic remote tip alone).
# Materialization drop list is computed against that same OID.
run_rebase_onto_target() {
    local target="$1"
    local drop_list editor_script merge_base rc

    drop_list="$(mktemp)"
    editor_script="$(mktemp)"
    merge_base="$(git merge-base HEAD "$target" 2>/dev/null || true)"
    export GIT_SEQUENCE_EDITOR=:
    if [ -n "$merge_base" ]; then
        vault_sync_list_materialized_commits "$merge_base" "$target" "$drop_list" "$WIKI_DIR"
        if [ -s "$drop_list" ]; then
            while IFS= read -r drop_sha; do
                [ -n "$drop_sha" ] || continue
                log "DROP materialized commit $drop_sha (proven on $target)"
            done <"$drop_list"
            prepare_materialization_sequence_editor "$drop_list" "$editor_script"
            export GIT_SEQUENCE_EDITOR="$editor_script"
        fi
    fi
    git -c rebase.reapplyCherryPicks=true rebase "$target" 2>>"$LOG_FILE"
    rc=$?
    rm -f "$drop_list" "$editor_script"
    return $rc
}

# Surface a non-archive manual conflict: optional one owned stale-target retry,
# else review-required handoff. Returns 0 with REBASE_RC set when a retry was
# started (caller should continue the loop); exits 1 on handoff.
handle_manual_conflict() {
    local commit_msg="$1"
    local conflicts="$2"
    local live_oid old_target

    vault_sync_op_record_conflict_identity "$WIKI_DIR" "$OP_ID"

    # Test-only hook (unset in production): inject remote advance / human mutation.
    if [ -n "${VAULT_SYNC_TEST_ON_CONFLICT_HOOK:-}" ]; then
        eval "$VAULT_SYNC_TEST_ON_CONFLICT_HOOK"
    fi

    git fetch --quiet "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"
    live_oid="$(git rev-parse "$REMOTE/$BRANCH")"

    if vault_sync_op_may_retry "$WIKI_DIR" "$OP_ID" "$live_oid"; then
        log "RETRY stale target $TARGET_OID -> $live_oid op=$OP_ID"
        vault_sync_op_set_phase "$WIKI_DIR" "$OP_ID" "retrying"
        vault_sync_op_set_field "$WIKI_DIR" "$OP_ID" "retry_count" "1"
        git rebase --abort 2>>"$LOG_FILE" || true
        old_target="$TARGET_OID"
        TARGET_OID="$live_oid"
        # CAS update recovery target ref (expected old = previous TARGET_OID).
        if ! vault_sync_op_cas_recovery_target "$WIKI_DIR" "$OP_ID" "$TARGET_OID" "$old_target" 2>>"$LOG_FILE"; then
            vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "recovery-target-cas-failed"
            log "FAIL recovery target CAS failed op=$OP_ID old=$old_target new=$TARGET_OID"
            exit 1
        fi
        vault_sync_op_set_field "$WIKI_DIR" "$OP_ID" "target_oid" "$TARGET_OID"
        vault_sync_op_set_phase "$WIKI_DIR" "$OP_ID" "rebasing"
        run_rebase_onto_target "$TARGET_OID"
        REBASE_RC=$?
        return 0
    fi

    vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "semantic-conflict-or-stale-exhausted"
    log "MANUAL-RESOLVE-NEEDED ($commit_msg): $conflicts"
    echo "=== CONFLICT on non-archive commit op=$OP_ID ==="
    echo "Commit: $commit_msg"
    echo "Conflicted files:"
    echo "$conflicts"
    echo ""
    echo "Resolve manually, then run: git rebase --continue"
    exit 1
}

# Log handoff only for review-required journals (not complete ops that also set
# handoff=1). Prefer matching sequencer onto/orig-head to journal fields.
log_review_required_handoff_if_present() {
    local jdir jf op_id phase handoff j_target j_orig seq_onto seq_orig matched any_review
    local git_dir rebase_dir
    jdir="$(vault_sync_op_journal_dir "$WIKI_DIR" 2>/dev/null || true)"
    [ -n "${jdir:-}" ] && [ -d "$jdir" ] || return 0

    seq_onto=""
    seq_orig=""
    git_dir="$(git -C "$WIKI_DIR" rev-parse --git-dir 2>/dev/null || true)"
    case "$git_dir" in
        /*) ;;
        "") git_dir="" ;;
        *) git_dir="$WIKI_DIR/$git_dir" ;;
    esac
    rebase_dir=""
    if [ -n "$git_dir" ]; then
        if [ -d "$git_dir/rebase-merge" ]; then
            rebase_dir="$git_dir/rebase-merge"
        elif [ -d "$git_dir/rebase-apply" ]; then
            rebase_dir="$git_dir/rebase-apply"
        fi
    fi
    if [ -n "$rebase_dir" ]; then
        [ -f "$rebase_dir/onto" ] && seq_onto="$(tr -d '[:space:]' <"$rebase_dir/onto")"
        if [ -f "$rebase_dir/orig-head" ]; then
            seq_orig="$(tr -d '[:space:]' <"$rebase_dir/orig-head")"
        elif [ -f "$rebase_dir/orig_head" ]; then
            seq_orig="$(tr -d '[:space:]' <"$rebase_dir/orig_head")"
        fi
    fi

    matched=0
    any_review=0
    for jf in "$jdir"/*.env; do
        [ -f "$jf" ] || continue
        op_id="$(basename "$jf" .env)"
        phase="$(vault_sync_op_get_field "$WIKI_DIR" "$op_id" phase 2>/dev/null || true)"
        handoff="$(vault_sync_op_get_field "$WIKI_DIR" "$op_id" handoff 2>/dev/null || true)"
        # Only review-required (ignore complete ops that also set handoff=1).
        [ "$phase" = "review-required" ] || continue
        [ "$handoff" = "1" ] || continue
        any_review=1
        j_target="$(vault_sync_op_get_field "$WIKI_DIR" "$op_id" target_oid 2>/dev/null || true)"
        j_orig="$(vault_sync_op_get_field "$WIKI_DIR" "$op_id" original_head 2>/dev/null || true)"
        if [ -n "$seq_onto" ] && [ -n "$j_target" ] && [ "$seq_onto" = "$j_target" ]; then
            if [ -z "$seq_orig" ] || [ -z "$j_orig" ] || [ "$seq_orig" = "$j_orig" ]; then
                log "handoff journal present; refusing auto-cleanup op=${op_id} (sequencer match)"
                matched=1
                break
            fi
        fi
    done

    if [ "$matched" -eq 0 ] && [ "$any_review" -eq 1 ]; then
        # review-required handoff exists but sequencer fields did not uniquely match;
        # still note handoff without claiming complete-op journals.
        log "handoff journal present; refusing auto-cleanup"
    fi
}

cd "$WIKI_DIR" || { log "ERROR: cd $WIKI_DIR failed"; exit 1; }

# Serialize with managed CLI writers (shared lock path). Fail closed on contention.
if ! vault_sync_managed_lock_acquire "$WIKI_DIR" "wiki-pull"; then
    log "FAIL managed-write lock held — refusing concurrent pull"
    exit 1
fi

# Stable handoff gate: never open a new journal/stash while unmerged paths,
# an in-progress non-rebase Git operation, or a review-required journal exist.
PREFLIGHT_BLOCKER="$(vault_sync_op_preflight_blocker "$WIKI_DIR" 2>/dev/null || true)"
if [ -n "$PREFLIGHT_BLOCKER" ]; then
    PREFLIGHT_REASON="${PREFLIGHT_BLOCKER%%	*}"
    PREFLIGHT_OP="${PREFLIGHT_BLOCKER#*	}"
    [ "$PREFLIGHT_OP" = "$PREFLIGHT_BLOCKER" ] && PREFLIGHT_OP=""
    log "HANDOFF existing reason=$PREFLIGHT_REASON op=${PREFLIGHT_OP:-none}; no new operation"
    printf 'VAULT_SYNC_HANDOFF reason=%s op=%s\n' "$PREFLIGHT_REASON" "${PREFLIGHT_OP:-none}"
    exit 2
fi

# Classify leftover rebase state. Active rebases fail closed; stale-clean
# state is cleared with recovery-ref + quit (never abort — abort would reset
# the branch tip to orig-head and discard newer authored work).
# Handoff immunity: never abort a rebase owned by a handoff journal.
# Active rebase with unmerged paths is handled by the preflight gate above
# (exit 2). Active rebase without unmerged paths still fails closed here.
if [ -d "$WIKI_DIR/.git/rebase-merge" ] || [ -d "$WIKI_DIR/.git/rebase-apply" ]; then
    REBASE_STATE="$(vault_sync_rebase_state "$WIKI_DIR")"
    log "REBASE-STATE $REBASE_STATE"
    case "$REBASE_STATE" in
        none)
            ;;
        stale-clean)
            PRE_CLEANUP_HEAD="$(git rev-parse HEAD)"
            if vault_sync_clear_stale_rebase "$WIKI_DIR"; then
                POST_CLEANUP_HEAD="$(git rev-parse HEAD)"
                if [ "$PRE_CLEANUP_HEAD" != "$POST_CLEANUP_HEAD" ]; then
                    log "FAIL stale rebase cleanup moved HEAD ($PRE_CLEANUP_HEAD -> $POST_CLEANUP_HEAD)"
                    exit 1
                fi
                log "CLEANUP stale-clean rebase via quit (tip preserved at $PRE_CLEANUP_HEAD)"
            else
                log "FAIL could not clear stale-clean rebase state safely"
                exit 1
            fi
            ;;
        active|*)
            log "FAIL active rebase state present — refusing auto-cleanup"
            log_review_required_handoff_if_present
            exit 1
            ;;
    esac
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
    if ! verify_no_tracked_conflict_markers; then
        exit 1
    fi
    log "UP-TO-DATE (0 behind)"
    exit 0
fi

log "PULL --rebase ($BEHIND commits behind)"

# Cooperative lock before first mutation (untracked overlap handling, stash, rebase).
if ! acquire_pull_lock; then
    exit 1
fi

# Begin journal + freeze target BEFORE untracked-overlap mutations so the
# operation owns the whole convergence transaction.
OP_ID="pull-$(hostname -s 2>/dev/null || echo host)-$(date -u +%Y%m%dT%H%M%SZ)-${$}-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ORIGINAL_HEAD="$(git rev-parse HEAD)"
# Freeze the convergence tip as an exact OID (not a moving symbolic name).
TARGET_OID="$(git rev-parse "$REMOTE/$BRANCH")"
HELPER_VERSION="${VAULT_SYNC_HELPER_VERSION:-unknown}"
RUNTIME_HASH="${VAULT_SYNC_RUNTIME_HASH:-}"
LOCK_IDENTITY="$LOCK_FILE"

if ! vault_sync_op_begin "$WIKI_DIR" "$OP_ID" "$ORIGINAL_BRANCH" "$ORIGINAL_HEAD" "$TARGET_OID" \
    "$LOCK_IDENTITY" "$HELPER_VERSION" "$RUNTIME_HASH"; then
  log "FAIL could not begin operation journal"
  exit 1
fi

if ! drop_or_preserve_untracked_remote_overlaps; then
    vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "untracked-overlap-failed"
    exit 1
fi

INV="$(mktemp)"
vault_sync_op_write_inventory "$WIKI_DIR" "$INV"
vault_sync_op_record_inventory "$WIKI_DIR" "$OP_ID" "$INV"
rm -f "$INV"

OWNED_STASH_OID=""
PRESERVE_SCOPE="none"
NEED_STASH=0
INCLUDE_UNTRACKED=0
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  NEED_STASH=1
  PRESERVE_SCOPE="tracked"
fi
if [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  # After drop_or_preserve_untracked_remote_overlaps, remaining untracked must be preserved.
  NEED_STASH=1
  INCLUDE_UNTRACKED=1
  if [ "$PRESERVE_SCOPE" = "tracked" ]; then
    PRESERVE_SCOPE="tracked+untracked"
  else
    PRESERVE_SCOPE="untracked"
  fi
fi

if [ "$NEED_STASH" -eq 1 ]; then
  STASH_MSG="vault-sync op=${OP_ID} $(date -u +%Y-%m-%dT%H:%MZ)"
  if OWNED_STASH_OID="$(vault_sync_op_stash_push_owned "$WIKI_DIR" "$STASH_MSG" "$INCLUDE_UNTRACKED")"; then
    vault_sync_op_record_stash "$WIKI_DIR" "$OP_ID" "$OWNED_STASH_OID" "$PRESERVE_SCOPE"
    log "STASH oid=$OWNED_STASH_OID scope=$PRESERVE_SCOPE op=$OP_ID"
  else
    vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "stash-failed"
    log "FAIL stash before rebase"
    exit 1
  fi
fi

# Test-only hook (unset in production): crash after stash to prove journal retention.
if [ "${VAULT_SYNC_TEST_EXIT_AFTER_STASH:-0}" = "1" ]; then
  log "TEST exit after stash"
  exit 99
fi

vault_sync_op_set_phase "$WIKI_DIR" "$OP_ID" "rebasing"

# Run rebase onto frozen TARGET_OID with auto-resolve for archive conflict storms.
# --reapply-cherry-picks prevents git from skipping matching patch-ids and
# dirtying the working tree mid-rebase. Prefer `git rebase $TARGET_OID` over
# `pull --rebase` so the pin is explicit (fetch already done).
run_rebase_onto_target "$TARGET_OID"
REBASE_RC=$?

# Defense-in-depth: cap rebase iterations so a silent resolver failure cannot
# spin the unattended pull forever. A healthy conflict storm is bounded by the
# number of commits being replayed; 200 is well above any realistic rebase.
MAX_REBASE_ITERS=200
REBASE_ITERS=0

while [ $REBASE_RC -ne 0 ]; do
    REBASE_ITERS=$((REBASE_ITERS + 1))
    if [ $REBASE_ITERS -gt $MAX_REBASE_ITERS ]; then
        log "FAIL rebase iteration cap ($MAX_REBASE_ITERS) exceeded — aborting to avoid spin"
        vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "rebase-iteration-cap"
        git rebase --abort 2>/dev/null || true
        exit 1
    fi

    # Check if we're in a rebase conflict state
    if [ ! -d "$WIKI_DIR/.git/rebase-merge" ]; then
        # Rebase failed before starting. Fall back to a normal merge so the
        # unattended push loop does not wedge on recoverable non-rebase errors.
        log "REBASE failed to start (rc=$REBASE_RC) — falling back to merge"
        git rebase --abort 2>/dev/null || true
        if git merge --no-edit "$TARGET_OID" 2>>"$LOG_FILE"; then
            log "OK fallback merge succeeded"
            REBASE_RC=0
        else
            vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "fallback-merge-failed"
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
            vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "rebase-continue-no-conflicts"
            log "FAIL rebase continue (no conflicts but failed)"
            exit 1
        fi
        REBASE_RC=$?
        continue
    fi

    if try_auto_resolve_derived_conflicts "$OP_ID"; then
        if ! GIT_EDITOR=true git rebase --continue 2>>"$LOG_FILE"; then
            REBASE_RC=$?
        else
            REBASE_RC=0
        fi
        continue
    fi

    # Composite resolver declined (unknown paths or failure). Manual path:
    # one owned stale-target retry, else handoff — no blanket --ours.
    STOPPED_SHA=$(cat "$WIKI_DIR/.git/rebase-merge/stopped-sha" 2>/dev/null || echo "")
    if [ -z "$STOPPED_SHA" ]; then
        vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "missing-stopped-sha"
        log "WARN cannot determine stopped-sha — surfacing conflicts"
        exit 1
    fi

    COMMIT_MSG=$(git log --format=%s -1 "$STOPPED_SHA" 2>/dev/null || echo "")
    handle_manual_conflict "$COMMIT_MSG" "$CONFLICTS"
    continue
done

if [ -n "$OWNED_STASH_OID" ]; then
  if vault_sync_op_stash_apply_owned "$WIKI_DIR" "$OWNED_STASH_OID" 2>>"$LOG_FILE"; then
    if ! vault_sync_op_verify_inventory "$WIKI_DIR" "$OP_ID" "$OWNED_STASH_OID" 2>>"$LOG_FILE"; then
      vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "inventory-verify-failed"
      log "FAIL inventory verification after stash apply oid=$OWNED_STASH_OID"
      exit 1
    fi
    if vault_sync_op_stash_drop_owned "$WIKI_DIR" "$OWNED_STASH_OID" 2>>"$LOG_FILE"; then
      log "STASH apply+drop ok oid=$OWNED_STASH_OID"
    else
      log "WARN could not drop owned stash oid=$OWNED_STASH_OID"
    fi
  else
    CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null)
    vault_sync_op_set_phase "$WIKI_DIR" "$OP_ID" "restoring"
    if [ -n "$CONFLICTS" ] && try_auto_resolve_derived_conflicts "$OP_ID"; then
      if [ -n "$(git diff --name-only --diff-filter=U 2>/dev/null)" ]; then
        vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "stash-restore-conflicts"
        log "FAIL stash apply derived auto-resolve left conflicts"
        exit 1
      fi
      # Derived regeneration rewrites conflicted paths; verify presence for those
      # paths and content for everything else.
      SKIP_CONTENT="$(printf '%s\n' $CONFLICTS)"
      if ! vault_sync_op_verify_inventory "$WIKI_DIR" "$OP_ID" "$OWNED_STASH_OID" "$SKIP_CONTENT" 2>>"$LOG_FILE"; then
        vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "inventory-verify-failed"
        log "FAIL inventory verification after derived auto-resolve oid=$OWNED_STASH_OID"
        exit 1
      fi

      vault_sync_op_stash_drop_owned "$WIKI_DIR" "$OWNED_STASH_OID" 2>>"$LOG_FILE" || true
      log "STASH apply derived conflicts auto-resolved"
    else
      vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "semantic-conflict"
      log "FAIL stash apply after rebase oid=$OWNED_STASH_OID"
      exit 1
    fi
  fi
fi

if ! verify_no_tracked_conflict_markers; then
    vault_sync_op_mark_review_required "$WIKI_DIR" "$OP_ID" "conflict-markers-remain"
    exit 1
fi

# Pull helper does not push; close the owned journal after successful convergence.
vault_sync_op_close_complete "$WIKI_DIR" "$OP_ID"
log "OK pull completed op=$OP_ID"
exit 0
