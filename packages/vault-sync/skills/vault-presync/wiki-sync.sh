#!/bin/bash
# wiki-sync.sh — Pre-sync helper for ~/wiki (vault-presync)
# Run before git push or after editing sessions to sync safely.
#
# Sources lib/platform.sh for cross-platform abstractions.
#
# SAFE BY DEFAULT: runs in dry-run mode unless --execute is passed.
#
# What it does:
#   1. Fetches remote state, checks AHEAD/BEHIND
#   2. Runs skillwiki lint-delta (blocks only on new errors; inherited visible)
#   3. Finds local untracked files that remote already tracks
#      - Byte-identical → removes (safe dedup)
#      - Content differs → preserves as LOCAL_EDITS
#   4. Detects potential rebase conflicts (files touched by both sides)
#   5. On --execute: delegates pull/rebase to wiki-pull-with-auto-resolve.sh
#   6. Reports remaining untracked files (genuine new work)
#
# Usage:
#   ./wiki-sync.sh              # dry-run (safe, preview only)
#   ./wiki-sync.sh --execute    # actually remove collisions and rebase
#   ./wiki-sync.sh --force      # skip lint gate (use with care)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source platform.sh — handles both dev (../../scripts/lib/) and deployed (lib/) layouts
if [ -f "$SCRIPT_DIR/lib/platform.sh" ]; then
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/lib/platform.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/platform.sh" ]; then
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/../../scripts/lib/platform.sh"
fi
platform_detect_os

# Resolve canonical pull helper (dev tree vs deployed plugin layout)
resolve_pull_helper() {
    local candidate
    for candidate in \
        "$SCRIPT_DIR/../../scripts/wiki-pull-with-auto-resolve.sh" \
        "$SCRIPT_DIR/../scripts/wiki-pull-with-auto-resolve.sh" \
        "$SCRIPT_DIR/wiki-pull-with-auto-resolve.sh" \
        "$SCRIPT_DIR/lib/../wiki-pull-with-auto-resolve.sh"
    do
        if [ -x "$candidate" ] || [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

# Auto-detect vault root: skillwiki config → git root → script-relative → fallback
if command -v skillwiki &>/dev/null; then
    WIKI_DIR=$(skillwiki path 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['path'])" 2>/dev/null) || true
fi
if [[ -z "${WIKI_DIR:-}" ]]; then
    WIKI_DIR=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null) || true
fi
if [[ -z "${WIKI_DIR:-}" ]]; then
    WIKI_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd 2>/dev/null)" || true
fi
: "${WIKI_DIR:=$HOME/wiki}"

DRY_RUN=true
SKIP_LINT=false
[[ "${1:-}" == "--execute" ]] && DRY_RUN=false
[[ "${1:-}" == "--force" ]] && { DRY_RUN=false; SKIP_LINT=true; }
[[ "${2:-}" == "--force" ]] && SKIP_LINT=true

cd "$WIKI_DIR"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

log()   { echo -e "[wiki-sync] $*"; }
warn()  { echo -e "[wiki-sync] ${YELLOW}WARN:${NC} $*" >&2; }
error() { echo -e "[wiki-sync] ${RED}ERROR:${NC} $*" >&2; }
ok()    { echo -e "[wiki-sync] ${GREEN}OK:${NC} $*"; }

# Peer-detectable stash name format retained for documentation / external tooling.
# The canonical pull helper owns stash lifecycle (journals owned stash OID); wiki-sync
# must not pre-stash/pop around the helper.
make_wiki_sync_stash_msg() {
    local summary="${1:-pre-pull}"
    local session_id cwd_hash iso
    session_id="${SKILLWIKI_SESSION_ID:-${CLAUDE_SESSION_ID:-local}}"
    # 8-char cwd hash (portable)
    cwd_hash="$(printf '%s' "$WIKI_DIR" | shasum -a 256 2>/dev/null | cut -c1-8)"
    if [ -z "$cwd_hash" ]; then
        cwd_hash="$(printf '%s' "$WIKI_DIR" | cksum | awk '{print $1}')"
    fi
    iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'wiki-sync:%s:%s:%s:%s' "$session_id" "$cwd_hash" "$iso" "$summary"
}

# Parse lint-delta JSON; print full/base/new/resolved; return 0 if new_errors==0.
# Fail closed on missing CLI or malformed output.
run_lint_delta_gate() {
    local out rc new_errors full_errors base_errors resolved_errors
    if ! command -v skillwiki &>/dev/null; then
        error "skillwiki CLI not available — lint-delta gate fails closed"
        return 1
    fi
    set +e
    out=$(skillwiki sync lint-delta "$WIKI_DIR" --base-ref origin/main 2>&1)
    rc=$?
    set -e
    # Extract counts via python (stable JSON envelope)
    eval "$(printf '%s\n' "$out" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    data=d.get("data") or {}
    print("full_errors=%s" % int(data.get("full_errors", -1)))
    print("base_errors=%s" % int(data.get("base_errors", -1)))
    print("new_errors=%s" % int(data.get("new_errors", -1)))
    print("resolved_errors=%s" % int(data.get("resolved_errors", -1)))
except Exception:
    print("full_errors=-1")
    print("base_errors=-1")
    print("new_errors=-1")
    print("resolved_errors=-1")
' 2>/dev/null)" || {
        full_errors=-1; base_errors=-1; new_errors=-1; resolved_errors=-1
    }

    if [ "${full_errors:- -1}" = "-1" ] || [ "${new_errors:--1}" = "-1" ]; then
        error "lint-delta evidence missing or malformed — fail closed"
        printf '%s\n' "$out" >&2
        return 1
    fi

    log "Lint delta: full=$full_errors base=$base_errors new=$new_errors resolved=$resolved_errors"
    if [ "$new_errors" -gt 0 ]; then
        error "Lint introduced $new_errors new error(s) (full=$full_errors). Fix before syncing, or use --force to skip."
        return 1
    fi
    if [ "$full_errors" -gt 0 ]; then
        warn "Inherited lint debt remains: full_errors=$full_errors (outgoing introduced 0 new errors)."
    fi
    return 0
}

# ── 1. Fetch ──────────────────────────────────────────────
log "Fetching origin..."
git fetch origin 2>&1 | tail -1 || { error "Fetch failed — network issue?"; exit 1; }

# ── 2. State check ────────────────────────────────────────
BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")
AHEAD=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "0")
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

log "State: behind=$BEHIND  ahead=$AHEAD  dirty=$DIRTY"

if [[ "$AHEAD" -gt 0 && "$BEHIND" -gt 0 ]]; then
    warn "Divergent history: $AHEAD local commit(s) + $BEHIND remote commit(s)."
    warn "Will use rebase to replay local on top of remote."
elif [[ "$BEHIND" -gt 0 ]]; then
    log "Local is $BEHIND commits behind origin/main."
elif [[ "$AHEAD" -gt 0 ]]; then
    log "Local is $AHEAD commits ahead of origin/main — ready to push after sync."
else
    log "Already in sync with origin/main."
fi

# ── 3. Lint gate (delta) ──────────────────────────────────
if [[ "$SKIP_LINT" == true ]]; then
    warn "Skipping lint gate (--force)."
else
    if ! run_lint_delta_gate; then
        if [[ "$DRY_RUN" == true ]]; then
            log "[DRY RUN] Would block sync here."
        else
            exit 1
        fi
    fi
fi

# ── 4. Find collision candidates ──────────────────────────
COLLISIONS=()
LOCAL_EDITS=()
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    if git cat-file -e "origin/main:$file" 2>/dev/null; then
        if diff -q <(git show "origin/main:$file") "$file" >/dev/null 2>&1; then
            COLLISIONS+=("$file")
        else
            LOCAL_EDITS+=("$file")
        fi
    fi
done < <(git ls-files --others --exclude-standard 2>/dev/null)

if [[ ${#COLLISIONS[@]} -gt 0 ]]; then
    if [[ "$DRY_RUN" == true ]]; then
        log "[DRY RUN] Would remove ${#COLLISIONS[@]} identical duplicates:"
    else
        log "Removing ${#COLLISIONS[@]} identical duplicates:"
    fi
    for f in "${COLLISIONS[@]}"; do
        log "  rm  $f"
        [[ "$DRY_RUN" != true ]] && rm -f "$f"
    done
else
    log "No byte-identical collisions found."
fi

if [[ ${#LOCAL_EDITS[@]} -gt 0 ]]; then
    warn "${#LOCAL_EDITS[@]} untracked file(s) differ from remote (will NOT delete):"
    for f in "${LOCAL_EDITS[@]}"; do warn "  keep  $f"; done
fi

# ── 5. Pre-rebase conflict detection ──────────────────────
if [[ "$BEHIND" -gt 0 && "$AHEAD" -gt 0 ]]; then
    LOCAL_FILES=$(git diff --name-only origin/main..HEAD 2>/dev/null || true)
    REMOTE_FILES=$(git diff --name-only HEAD..origin/main 2>/dev/null || true)
    OVERLAP=$(comm -12 <(echo "$LOCAL_FILES" | sort) <(echo "$REMOTE_FILES" | sort) 2>/dev/null || true)
    if [[ -n "$OVERLAP" ]]; then
        OVERLAP_COUNT=$(echo "$OVERLAP" | grep -c . 2>/dev/null || echo "0")
        warn "Rebase conflict likely: $OVERLAP_COUNT file(s) touched by both sides:"
        echo "$OVERLAP" | while read -r f; do warn "  conflict  $f"; done
        warn "These will need manual resolution during rebase."
    else
        ok "No overlapping files — rebase should be clean."
    fi
fi

# ── 6. Dry-run exit ───────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
    log "[DRY RUN] Preview complete. No changes made."
    if [[ "$AHEAD" -gt 0 || "$BEHIND" -gt 0 || ${#COLLISIONS[@]} -gt 0 ]]; then
        log "Run with --execute to apply."
    fi
    exit 0
fi

# ── 7. Pull via canonical helper ──────────────────────────
if [[ "$BEHIND" -gt 0 ]]; then
    PULL_HELPER="$(resolve_pull_helper)" || {
        error "Cannot locate wiki-pull-with-auto-resolve.sh"
        exit 1
    }
    log "Delegating pull/rebase to canonical helper: $PULL_HELPER"
    # Helper owns dirty-tree stash lifecycle (owned stash OID + journal).
    # Do not pre-stash/pop here — that double-stashes and risks unqualified pop.

    set +e
    WIKI_DIR="$WIKI_DIR" bash "$PULL_HELPER" origin main
    PULL_RC=$?
    set -e

    if [[ "$PULL_RC" -ne 0 ]]; then
        error "Canonical pull helper failed (exit $PULL_RC)."
        error "If a rebase is active: resolve conflicts, then git rebase --continue"
        error "Active rebases are never auto-aborted."
        exit 1
    fi
    ok "Canonical pull helper succeeded."
elif [[ "$AHEAD" -gt 0 ]]; then
    log "No remote commits to pull — local is ahead. Ready to push."
else
    log "Already in sync."
fi

# ── 8. Cleanup ────────────────────────────────────────────
find "$WIKI_DIR" -type d -empty -not -path '*/.git/*' -delete 2>/dev/null || true

REMAINING=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
log "Sync complete. $REMAINING untracked file(s) remaining (genuine new work)."

if [[ "$AHEAD" -gt 0 ]] || ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    log "Vault has local changes — ready for commit + push."
fi
