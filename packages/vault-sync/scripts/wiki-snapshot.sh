#!/bin/bash
# wiki-snapshot.sh — Placeholder for sg01 snapshot/promotion script.
#
# This file will be populated from sg01's wiki-snapshot-v3.sh during
# hand-migration. Do NOT run this on production hosts.
#
# Current status:
#   - Guard verification is implemented (wiki_snapshot_assert_guards)
#   - The full rsync+git+push body will be migrated during hand-migration
#     from sg01's /root/.hermes/scripts/wiki-snapshot-v3.sh
#
# Hard Rule (NON-NEGOTIABLE):
#   The sg01 script MUST have --max-delete 10 in its rclone sync call.
#   This guard prevents mass file deletion during S3 inconsistency events.
#   Reference: raw/transcripts/2026-05-23-bug-sg01-snapshot-destructive-rclone-sync.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source platform.sh — handles both dev (scripts/lib/) and deployed (lib/) layouts
if [ -f "$SCRIPT_DIR/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/lib/platform.sh"
elif [ -f "$SCRIPT_DIR/scripts/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/scripts/lib/platform.sh"
elif [ -f "$SCRIPT_DIR/../../scripts/lib/platform.sh" ]; then
    source "$SCRIPT_DIR/../../scripts/lib/platform.sh"
fi
platform_detect_os

# ── Guard: Linux-only operation ────────────────────────────
platform_require linux

# ── Guard: --max-delete verification ───────────────────────
# Verify that the sg01 snapshot script has the --max-delete 10 guard.
# Returns 0 if guard is present, 1 if missing.
wiki_snapshot_assert_guards() {
    local script_path="$1"

    if [ ! -f "$script_path" ]; then
        echo "FATAL: snapshot script not found: $script_path" >&2
        return 1
    fi

    if grep -q -- '--max-delete' "$script_path" 2>/dev/null; then
        echo "OK: --max-delete guard present in $script_path"
        return 0
    else
        echo "FATAL: --max-delete guard MISSING from $script_path" >&2
        echo "Do NOT run this script on production until the guard is added." >&2
        echo "Reference: raw/transcripts/2026-05-23-bug-sg01-snapshot-destructive-rclone-sync.md" >&2
        return 1
    fi
}

# ── Guard: verify this script itself has its guard lines ───
# Self-check: ensure this placeholder contains the max-delete mention.
wiki_verify_self_guard() {
    local self="$0"
    if grep -q -- '--max-delete' "$self" 2>/dev/null; then
        return 0
    fi
    echo "WARNING: $self is missing its own --max-delete guard documentation." >&2
    return 1
}

# ── Dry-run mode ────────────────────────────────────────────
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

if [ "$DRY_RUN" = true ]; then
    echo "[wiki-snapshot] DRY RUN: platform=$(platform_detect_os), os=${VS_OS:-unknown}"
    echo "[wiki-snapshot] DRY RUN: guardian checks would run, then snapshot body would execute."
    wiki_verify_self_guard
    echo "[wiki-snapshot] DRY RUN: Complete. No changes made."
    exit 0
fi

# ── Deferred: full snapshot body ────────────────────────────
# The full snapshot body (rsync from rclone mount, git commit, rebase, push)
# will be migrated here during hand-migration from sg01's wiki-snapshot-v3.sh.
# See: ~/wiki/_archive/2026-05-25/sg01-stray-scripts/ for the v2 reference.

echo "[wiki-snapshot] Placeholder only. Run wiki_verify_self_guard to confirm guard presence."
wiki_verify_self_guard
exit 0
