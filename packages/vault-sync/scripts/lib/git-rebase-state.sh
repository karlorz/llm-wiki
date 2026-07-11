#!/bin/bash
# git-rebase-state.sh — classify and safely clear Git rebase sequencer state.
#
# Bash 3.2 compatible. Source from vault-sync scripts.
#
# Classification (stdout):
#   none        — no rebase sequencer directory
#   active      — real in-progress rebase (must not auto-clear)
#   stale-clean — sequencer dir exists, worktree clean of unmerged paths,
#                 live tip differs from recorded orig-head
#
# Cleanup for stale-clean:
#   1. Create refs/vault-sync/recovery/<UTC timestamp> at current HEAD
#   2. git rebase --quit (never --abort, never raw rm -rf of sequencer)
#   3. Verify HEAD unchanged

# Returns 0 and prints classification on stdout.
vault_sync_rebase_state() {
    local repo="${1:-.}"
    local git_dir rebase_dir orig_head live_head unmerged rebase_head

    if ! git_dir="$(git -C "$repo" rev-parse --git-dir 2>/dev/null)"; then
        printf 'active\n'
        return 0
    fi
    # Make absolute if relative
    case "$git_dir" in
        /*) ;;
        *) git_dir="$repo/$git_dir" ;;
    esac

    rebase_dir=""
    if [ -d "$git_dir/rebase-merge" ]; then
        rebase_dir="$git_dir/rebase-merge"
    elif [ -d "$git_dir/rebase-apply" ]; then
        rebase_dir="$git_dir/rebase-apply"
    else
        printf 'none\n'
        return 0
    fi

    # Unmerged paths → always active
    unmerged="$(git -C "$repo" diff --name-only --diff-filter=U 2>/dev/null || true)"
    if [ -n "$unmerged" ]; then
        printf 'active\n'
        return 0
    fi

    # REBASE_HEAD present with matching in-progress context → active
    if git -C "$repo" rev-parse -q --verify REBASE_HEAD >/dev/null 2>&1; then
        rebase_head="$(git -C "$repo" rev-parse REBASE_HEAD 2>/dev/null || true)"
        live_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
        # If REBASE_HEAD resolves and sequencer has stopped-sha / head-name, treat as active
        # unless we can prove stale-clean (tip advanced past orig-head with clean tree).
        if [ -f "$rebase_dir/orig-head" ] || [ -f "$rebase_dir/orig_head" ]; then
            :
        else
            printf 'active\n'
            return 0
        fi
        # REBASE_HEAD + clean tree but tip still at orig-head context → active
        orig_head=""
        if [ -f "$rebase_dir/orig-head" ]; then
            orig_head="$(tr -d '[:space:]' < "$rebase_dir/orig-head" 2>/dev/null || true)"
        elif [ -f "$rebase_dir/orig_head" ]; then
            orig_head="$(tr -d '[:space:]' < "$rebase_dir/orig_head" 2>/dev/null || true)"
        fi
        if [ -n "$orig_head" ] && [ -n "$live_head" ]; then
            if [ "$live_head" = "$orig_head" ] || [ "$live_head" = "$rebase_head" ]; then
                printf 'active\n'
                return 0
            fi
            # Tip advanced past orig-head with no unmerged paths → stale-clean
            if git -C "$repo" merge-base --is-ancestor "$orig_head" "$live_head" 2>/dev/null \
                && [ "$live_head" != "$orig_head" ]; then
                # Also require clean index/worktree (no unstaged/staged beyond rebase)
                if git -C "$repo" diff --quiet 2>/dev/null \
                    && git -C "$repo" diff --cached --quiet 2>/dev/null; then
                    printf 'stale-clean\n'
                    return 0
                fi
            fi
        fi
        # Fail closed: unknown REBASE_HEAD context is active
        printf 'active\n'
        return 0
    fi

    # No REBASE_HEAD. Sequencer dir may be empty/corrupt or left after tip advance.
    orig_head=""
    if [ -f "$rebase_dir/orig-head" ]; then
        orig_head="$(tr -d '[:space:]' < "$rebase_dir/orig-head" 2>/dev/null || true)"
    elif [ -f "$rebase_dir/orig_head" ]; then
        orig_head="$(tr -d '[:space:]' < "$rebase_dir/orig_head" 2>/dev/null || true)"
    fi
    live_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"

    if [ -n "$orig_head" ] && [ -n "$live_head" ] && [ "$live_head" != "$orig_head" ]; then
        if git -C "$repo" diff --quiet 2>/dev/null \
            && git -C "$repo" diff --cached --quiet 2>/dev/null; then
            printf 'stale-clean\n'
            return 0
        fi
    fi

    # Empty/corrupt sequencer with no REBASE_HEAD and tip == orig-head or no orig-head:
    # treat as stale-clean only when tree is clean (legacy empty rebase-merge cleanup).
    if [ -z "$(ls -A "$rebase_dir" 2>/dev/null || true)" ] \
        || { [ -z "$orig_head" ] || [ "$live_head" = "$orig_head" ]; }; then
        if git -C "$repo" diff --quiet 2>/dev/null \
            && git -C "$repo" diff --cached --quiet 2>/dev/null; then
            # Empty dir or tip still at orig-head with no REBASE_HEAD → safe quit
            printf 'stale-clean\n'
            return 0
        fi
    fi

    # Fail closed
    printf 'active\n'
    return 0
}

# Clear stale-clean rebase state without moving HEAD.
# Returns 0 on success, 1 if active / fail-closed / HEAD moved.
vault_sync_clear_stale_rebase() {
    local repo="${1:-.}"
    local state pre_head post_head recovery_ref ts

    state="$(vault_sync_rebase_state "$repo")"
    case "$state" in
        none)
            return 0
            ;;
        active)
            return 1
            ;;
        stale-clean)
            ;;
        *)
            return 1
            ;;
    esac

    pre_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || return 1
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    recovery_ref="refs/vault-sync/recovery/${ts}"
    if ! git -C "$repo" update-ref "$recovery_ref" "$pre_head" 2>/dev/null; then
        return 1
    fi

    # Prefer git rebase --quit (Git 2.12+). Never abort (would reset to orig-head).
    if ! git -C "$repo" rebase --quit 2>/dev/null; then
        # If quit fails but sequencer remains, fail closed — do not rm -rf.
        return 1
    fi

    post_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" || return 1
    if [ "$pre_head" != "$post_head" ]; then
        # Attempt to restore tip if quit somehow moved HEAD (should not happen).
        git -C "$repo" update-ref HEAD "$pre_head" 2>/dev/null || true
        return 1
    fi

    # Confirm sequencer gone; if still present after quit, fail closed.
    if [ -d "$(git -C "$repo" rev-parse --git-dir 2>/dev/null)/rebase-merge" ] \
        || [ -d "$(git -C "$repo" rev-parse --git-dir 2>/dev/null)/rebase-apply" ]; then
        # Re-resolve absolute git dir
        local git_dir
        git_dir="$(git -C "$repo" rev-parse --git-dir 2>/dev/null)"
        case "$git_dir" in
            /*) ;;
            *) git_dir="$repo/$git_dir" ;;
        esac
        if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; then
            return 1
        fi
    fi

    return 0
}
