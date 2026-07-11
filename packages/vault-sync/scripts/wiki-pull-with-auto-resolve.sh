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
platform_detect_os

WIKI_DIR="${WIKI_DIR:-$HOME/wiki}"
REMOTE="${1:-origin}"
BRANCH="${2:-main}"
LOG_FILE="$(platform_log_dir)/wiki-pull.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"; }

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

try_auto_resolve_log_union_conflicts() {
    local conflicts="$1"
    local f tmpdir base ours theirs merged
    local resolved=()

    for f in $conflicts; do
        if ! is_log_conflict_path "$f"; then
            return 1
        fi
    done

    for f in $conflicts; do
        tmpdir="$(mktemp -d)" || { log "WARN mktemp failed for log union conflict: $f"; rollback_resolved resolved; return 1; }
        base="$tmpdir/base"
        ours="$tmpdir/ours"
        theirs="$tmpdir/theirs"
        merged="$tmpdir/merged"

        if ! git show ":1:$f" >"$base" 2>/dev/null ||
           ! git show ":2:$f" >"$ours" 2>/dev/null ||
           ! git show ":3:$f" >"$theirs" 2>/dev/null; then
            rm -rf "$tmpdir"
            log "WARN cannot read all index stages for log union conflict: $f"
            rollback_resolved resolved
            return 1
        fi

        if ! git merge-file --union -p "$ours" "$base" "$theirs" >"$merged"; then
            rm -rf "$tmpdir"
            log "WARN log union merge failed: $f"
            rollback_resolved resolved
            return 1
        fi

        if ! cp "$merged" "$f"; then
            rm -rf "$tmpdir"
            log "WARN cannot write union merge to worktree: $f"
            rollback_resolved resolved
            return 1
        fi

        if ! git add "$f"; then
            rm -rf "$tmpdir"
            log "WARN git add failed for union merge: $f"
            rollback_resolved resolved
            return 1
        fi

        resolved+=("$f")
        rm -rf "$tmpdir"
    done

    log "AUTO-RESOLVE log union: $conflicts"
    return 0
}

is_project_knowledge_conflict_path() {
    [[ "$1" =~ ^projects/[^/]+/knowledge\.md$ ]]
}

project_slug_from_knowledge_path() {
    local path="$1"
    path="${path#projects/}"
    printf '%s\n' "${path%%/*}"
}

try_auto_resolve_project_knowledge_conflicts() {
    local conflicts="$1"
    local f slug slugs rc

    if ! command -v skillwiki >/dev/null 2>&1; then
        return 1
    fi

    for f in $conflicts; do
        if ! is_project_knowledge_conflict_path "$f"; then
            return 1
        fi
    done

    slugs="$(mktemp)" || { log "WARN mktemp failed for project knowledge conflict"; return 1; }
    for f in $conflicts; do
        project_slug_from_knowledge_path "$f" >>"$slugs"
    done

    rc=0
    while read -r slug; do
        [ -n "$slug" ] || continue
        if ! skillwiki project-index "$slug" "$WIKI_DIR" --apply >>"$LOG_FILE" 2>&1; then
            rc=1
        fi
    done < <(sort -u "$slugs")
    rm -f "$slugs"
    if [ "$rc" -ne 0 ]; then
        log "WARN project knowledge regeneration failed: $conflicts"
        return 1
    fi

    for f in $conflicts; do
        if ! git add "$f"; then
            log "WARN git add failed for regenerated project knowledge: $f"
            return 1
        fi
    done

    log "AUTO-RESOLVE project knowledge regeneration: $conflicts"
    return 0
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

cd "$WIKI_DIR" || { log "ERROR: cd $WIKI_DIR failed"; exit 1; }

# Classify leftover rebase state. Active rebases fail closed; stale-clean
# state is cleared with recovery-ref + quit (never abort — abort would reset
# the branch tip to orig-head and discard newer authored work).
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

if ! drop_or_preserve_untracked_remote_overlaps; then
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

# Drop only fully proven materialized local commits from the rebase todo.
DROP_LIST="$(mktemp)"
EDITOR_SCRIPT="$(mktemp)"
MERGE_BASE="$(git merge-base HEAD "$REMOTE/$BRANCH" 2>/dev/null || true)"
if [ -n "$MERGE_BASE" ]; then
    vault_sync_list_materialized_commits "$MERGE_BASE" "$REMOTE/$BRANCH" "$DROP_LIST" "$WIKI_DIR"
    if [ -s "$DROP_LIST" ]; then
        while IFS= read -r drop_sha; do
            [ -n "$drop_sha" ] || continue
            log "DROP materialized commit $drop_sha (proven on $REMOTE/$BRANCH)"
        done < "$DROP_LIST"
        prepare_materialization_sequence_editor "$DROP_LIST" "$EDITOR_SCRIPT"
        export GIT_SEQUENCE_EDITOR="$EDITOR_SCRIPT"
    else
        export GIT_SEQUENCE_EDITOR=:
    fi
else
    export GIT_SEQUENCE_EDITOR=:
fi

# Run rebase with auto-resolve for archive conflict storms.
# --reapply-cherry-picks prevents git from skipping matching patch-ids and
# dirtying the working tree mid-rebase.
git -c rebase.reapplyCherryPicks=true pull --rebase "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"
REBASE_RC=$?
rm -f "$DROP_LIST" "$EDITOR_SCRIPT"

# Defense-in-depth: cap rebase iterations so a silent resolver failure cannot
# spin the unattended pull forever. A healthy conflict storm is bounded by the
# number of commits being replayed; 200 is well above any realistic rebase.
MAX_REBASE_ITERS=200
REBASE_ITERS=0

while [ $REBASE_RC -ne 0 ]; do
    REBASE_ITERS=$((REBASE_ITERS + 1))
    if [ $REBASE_ITERS -gt $MAX_REBASE_ITERS ]; then
        log "FAIL rebase iteration cap ($MAX_REBASE_ITERS) exceeded — aborting to avoid spin"
        git rebase --abort 2>/dev/null || true
        exit 1
    fi

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

    if try_auto_resolve_project_knowledge_conflicts "$CONFLICTS"; then
        if ! GIT_EDITOR=true git rebase --continue 2>>"$LOG_FILE"; then
            REBASE_RC=$?
        else
            REBASE_RC=0
        fi
        continue
    fi

    if try_auto_resolve_log_union_conflicts "$CONFLICTS"; then
        if ! GIT_EDITOR=true git rebase --continue 2>>"$LOG_FILE"; then
            REBASE_RC=$?
        else
            REBASE_RC=0
        fi
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
        CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null)
        if [ -n "$CONFLICTS" ] && try_auto_resolve_project_knowledge_conflicts "$CONFLICTS"; then
            if [ -n "$(git diff --name-only --diff-filter=U 2>/dev/null)" ]; then
                log "FAIL stash pop project knowledge auto-resolve left conflicts"
                exit 1
            fi
            git stash drop 2>>"$LOG_FILE" >/dev/null || log "WARN could not drop auto-resolved stash"
            log "STASH pop project knowledge conflicts auto-resolved"
        else
            log "FAIL stash pop after rebase"
            exit 1
        fi
    fi
fi

if ! verify_no_tracked_conflict_markers; then
    exit 1
fi

log "OK pull completed"
exit 0
