#!/bin/bash
# delete-intent.sh — helpers for vault-delete-intent/v1 tombstones under
# meta/delete-intents/. Used by wiki-push (S3 prune) and wiki-snapshot
# (no-resurrect). Prefer reading from a vault worktree directory.

# Print active delete-intent paths (one per line) from VAULT/meta/delete-intents.
# Requires python3 for JSON. Silent empty on missing dir.
delete_intent_list_active_paths() {
    local vault="${1:-}"
    local dir
    [ -n "$vault" ] || return 0
    dir="$vault/meta/delete-intents"
    [ -d "$dir" ] || return 0

    python3 - "$dir" <<'PY'
import json, os, sys
from datetime import datetime, timezone

d = sys.argv[1]
now = datetime.now(timezone.utc)
paths = []
for name in sorted(os.listdir(d)):
    if not name.endswith(".json"):
        continue
    path = os.path.join(d, name)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        continue
    if data.get("schema") != "vault-delete-intent/v1":
        continue
    p = data.get("path")
    if not p or not data.get("action"):
        continue
    exp = data.get("expires")
    if exp not in (None, ""):
        try:
            # support Z suffix
            exp_s = str(exp).replace("Z", "+00:00")
            exp_dt = datetime.fromisoformat(exp_s)
            if exp_dt.tzinfo is None:
                exp_dt = exp_dt.replace(tzinfo=timezone.utc)
            if exp_dt <= now:
                continue
        except Exception:
            continue
    paths.append(p)
for p in sorted(set(paths)):
    print(p)
PY
}

# List active paths by reading JSON blobs from git ref (default origin/main).
# WORKTREE must be a git checkout; REF defaults to origin/main.
delete_intent_list_active_paths_from_git() {
    local worktree="${1:-}"
    local ref="${2:-origin/main}"
    [ -n "$worktree" ] || return 0
    [ -d "$worktree/.git" ] || [ -f "$worktree/.git" ] || return 0

    local tmp
    tmp="$(mktemp -d)" || return 0
    (
        cd "$worktree" || exit 0
        git ls-tree -r --name-only "$ref" -- meta/delete-intents/ 2>/dev/null | while IFS= read -r rel; do
            [ -z "$rel" ] && continue
            mkdir -p "$tmp/$(dirname "$rel")"
            git show "$ref:$rel" > "$tmp/$rel" 2>/dev/null || true
        done
    )
    delete_intent_list_active_paths "$tmp"
    rm -rf "$tmp"
}

# Print the sorted unique exact intersection between active tombstone paths and
# a successful remote inventory. Both inputs are newline-delimited
# vault-relative path files. This helper is pure: no network, logging, or
# mutation outside its temporary sort files.
delete_intent_plan_remote_paths() {
    local active_paths_file="${1:-}"
    local remote_paths_file="${2:-}"
    [ -f "$active_paths_file" ] || return 1
    [ -f "$remote_paths_file" ] || return 1

    local tmp_dir active_sorted remote_sorted rc
    tmp_dir="$(mktemp -d)" || return 1
    active_sorted="$tmp_dir/active.paths"
    remote_sorted="$tmp_dir/remote.paths"

    if ! LC_ALL=C sort -u "$active_paths_file" > "$active_sorted" \
        || ! LC_ALL=C sort -u "$remote_paths_file" > "$remote_sorted"; then
        rm -rf "$tmp_dir"
        return 1
    fi

    LC_ALL=C comm -12 "$active_sorted" "$remote_sorted"
    rc=$?
    rm -rf "$tmp_dir"
    return "$rc"
}
