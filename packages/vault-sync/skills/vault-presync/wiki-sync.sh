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
#   2. Runs skillwiki lint (warns on errors, continues on warnings)
#   3. Finds local untracked files that remote already tracks
#      - Byte-identical → removes (safe dedup)
#      - Content differs → preserves as LOCAL_EDITS
#   4. Detects potential rebase conflicts (files touched by both sides)
#   5. git pull --rebase (not ff-only — handles divergent histories)
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
    source "$SCRIPT_DIR/lib/platform.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/platform.sh"
fi
platform_detect_os

# Auto-detect vault root: skillwiki config → git root → script-relative → fallback
if command -v skillwiki &>/dev/null; then
    WIKI_DIR=$(skillwiki path 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['path'])" 2>/dev/null) || true
fi
if [[ -z "${WIKI_DIR:-}" ]]; then
    WIKI_DIR=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null) || true
fi
if [[ -z "${WIKI_DIR:-}" ]]; then
    # Script is at <vault-presync>/wiki-sync.sh → vault is 2 dirs up from scripts/lib/ or script-relative
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

need_confirm() {
    if [[ "$DRY_RUN" == true ]]; then
        warn "[DRY RUN] Would require confirmation: $*"
        return 1
    fi
    echo -n "$* [y/N] "
    read -r ans
    [[ "$ans" == "y" || "$ans" == "Y" ]]
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

# ── 3. Lint gate ──────────────────────────────────────────
if [[ "$SKIP_LINT" == true ]]; then
    warn "Skipping lint gate (--force)."
elif command -v skillwiki &>/dev/null; then
    LINT_OUT=$(skillwiki lint "$WIKI_DIR" 2>&1) || true
    LINT_ERRORS=$(echo "$LINT_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['summary']['errors'])" 2>/dev/null || echo "?")
    LINT_WARNINGS=$(echo "$LINT_OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['data']['summary']['warnings'])" 2>/dev/null || echo "?")
    log "Lint: errors=$LINT_ERRORS  warnings=$LINT_WARNINGS"
    if [[ "$LINT_ERRORS" != "0" && "$LINT_ERRORS" != "?" ]]; then
        error "Lint has $LINT_ERRORS error(s). Fix before syncing, or use --force to skip."
        if [[ "$DRY_RUN" == true ]]; then
            log "[DRY RUN] Would block sync here."
        else
            exit 1
        fi
    fi
else
    warn "skillwiki CLI not available — skipping lint gate."
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
    # Find files touched by both local commits and remote commits
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

# ── 7. Pull (rebase) ─────────────────────────────────────
if [[ "$BEHIND" -gt 0 ]]; then
    log "Rebasing $AHEAD local commit(s) onto origin/main..."

    STASHED=false
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        log "Stashing local tracked edits before rebase..."
        git stash push -m "wiki-sync auto-stash $(date +%s)"
        STASHED=true
    fi

    if git rebase origin/main; then
        ok "Rebase succeeded."
    else
        error "Rebase had conflicts. You're now in a rebase session."
        error ""
        error "Resolution steps:"
        error "  1. Fix conflicts: git diff --name-only --diff-filter=U"
        error "  2. For frontmatter 'updated:' conflicts: keep the newer timestamp"
        error "  3. For body conflicts: keep the version with more content"
        error "  4. git add <resolved-files>"
        error "  5. git rebase --continue"
        error "  6. Then: git stash pop  (if stash was created)"
        error ""
        error "To abort: git rebase --abort"
        [[ "$STASHED" == true ]] && warn "Stash is saved — pop it after resolving: git stash pop"
        exit 1
    fi

    if [[ "$STASHED" == true ]]; then
        log "Reapplying stashed edits..."
        if git stash pop; then
            ok "Stash reapplied cleanly."
        else
            error "Stash pop had conflicts."
            error "  - Your edits are in the stash (git stash list)"
            error "  - Resolve conflicts in the working tree"
            error "  - Then: git stash drop  (to remove the applied stash)"
            exit 1
        fi
    fi
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
