#!/bin/bash
# managed-write-lock.sh — shared CLI/shell managed-write lock (Bash 3.2).
# Source from vault-sync scripts. Lock path: git --git-path vault-sync/managed-write.lock
#
# Lifecycle:
# - Acquire uses noclobber create so concurrent live owners fail closed.
# - Release only removes the lock when this shell owns the token.
# - On acquire contention, a lock whose owner PID is dead may be reclaimed after
#   preserving the old lock record under vault-sync/recovery/ — never by age alone,
#   never while rebase/unmerged paths exist, never while a live PID holds it.

VAULT_SYNC_MANAGED_LOCK_PATH=""
VAULT_SYNC_MANAGED_LOCK_TOKEN_OWNED=""
VAULT_SYNC_MANAGED_LOCK_ACQUIRED=""
VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE=0

vault_sync_managed_lock_path() {
  local repo="${1:-.}"
  local path
  path="$(git -C "$repo" rev-parse --git-path vault-sync/managed-write.lock 2>/dev/null)" || return 1
  case "$path" in
    /*) printf '%s\n' "$path" ;;
    *) printf '%s\n' "$repo/$path" ;;
  esac
}

vault_sync_managed_lock_read_token() {
  local path="$1"
  [ -f "$path" ] || return 1
  sed -n 's/.*"owner_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$path" | head -1
}

vault_sync_managed_lock_read_pid() {
  local path="$1"
  [ -f "$path" ] || return 1
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$path" | head -1
}

# Returns 0 when PID appears alive, 1 when dead/unknown/missing.
vault_sync_managed_lock_pid_alive() {
  local pid="$1"
  case "$pid" in
    ""|*[!0-9]*) return 1 ;;
  esac
  # kill -0 succeeds if the process exists (or is not owned but present).
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Returns 0 when it is safe to reclaim a dead-owner lock for this repo.
vault_sync_managed_lock_safe_to_reclaim() {
  local repo="${1:-.}"
  local git_dir unmerged review_op

  git_dir="$(git -C "$repo" rev-parse --git-dir 2>/dev/null)" || return 1
  case "$git_dir" in
    /*) ;;
    *) git_dir="$repo/$git_dir" ;;
  esac

  # Never reclaim during an active/leftover sequencer.
  if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ] \
    || [ -f "$git_dir/MERGE_HEAD" ] || [ -f "$git_dir/CHERRY_PICK_HEAD" ] \
    || [ -f "$git_dir/REVERT_HEAD" ]; then
    return 1
  fi

  unmerged="$(git -C "$repo" ls-files -u 2>/dev/null | head -1 || true)"
  if [ -n "$unmerged" ]; then
    return 1
  fi

  # When journal helpers are loaded, a dead owner may close handoffs whose
  # target is already in HEAD, then continue reclaim in this same acquire.
  # Live owners never reach this function; active sequencers/unmerged paths
  # already failed closed above. Any unresolved handoff still blocks reclaim.
  if command -v vault_sync_op_supersede_stale_review_required >/dev/null 2>&1; then
    vault_sync_op_supersede_stale_review_required \
      "$repo" "vault-sync-managed-lock-reclaim" 2>/dev/null || return 1
  elif command -v vault_sync_op_find_review_required >/dev/null 2>&1; then
    review_op="$(vault_sync_op_find_review_required "$repo" 2>/dev/null || true)"
    [ -z "$review_op" ] || return 1
  fi

  return 0
}

# Preserve the current lock file under vault-sync/recovery/ then remove it.
# Returns 0 when the live lock path is gone (preserved or already absent).
vault_sync_managed_lock_preserve_and_clear() {
  local path="$1"
  local reason="${2:-owner_pid_dead}"
  local rec_dir rec_path ts body

  [ -n "$path" ] || return 1
  if [ ! -f "$path" ]; then
    return 0
  fi

  rec_dir="$(dirname "$path")/recovery"
  mkdir -p "$rec_dir" || return 1
  ts="$(date -u +%Y%m%dT%H%MZ 2>/dev/null || date +%Y%m%dT%H%M)"
  rec_path="$rec_dir/stale-managed-write-lock-${ts}-$$.json"
  body="$(cat "$path" 2>/dev/null || true)"
  if [ -n "$body" ]; then
    # Best-effort structured recovery record; fall back to raw bytes.
    if command -v python3 >/dev/null 2>&1; then
      REASON="$reason" BODY="$body" REC="$rec_path" python3 - <<'PY' 2>/dev/null || printf '%s\n' "$body" >"$rec_path"
import json, os, time
raw = os.environ.get("BODY", "").strip()
try:
    lock = json.loads(raw)
except Exception:
    lock = {"raw": raw}
meta = {
    "recovered_at": time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime()),
    "recovery_reason": os.environ.get("REASON", "owner_pid_dead"),
    "owner_pid_alive": False,
    "lock": lock,
}
open(os.environ["REC"], "w", encoding="utf-8").write(json.dumps(meta, indent=2) + "\n")
PY
    else
      printf '%s\n' "$body" >"$rec_path"
    fi
  fi

  rm -f -- "$path"
  [ ! -f "$path" ]
}

# If the lock path exists with a dead owner and reclaim is safe, preserve+clear.
# Returns 0 when lock path is free (reclaimed or never present), 1 when still held.
vault_sync_managed_lock_reclaim_dead_owner() {
  local repo="${1:-.}"
  local path pid

  path="$(vault_sync_managed_lock_path "$repo")" || return 1
  if [ ! -f "$path" ]; then
    return 0
  fi

  pid="$(vault_sync_managed_lock_read_pid "$path" || true)"
  if vault_sync_managed_lock_pid_alive "$pid"; then
    return 1
  fi

  if ! vault_sync_managed_lock_safe_to_reclaim "$repo"; then
    return 1
  fi

  vault_sync_managed_lock_preserve_and_clear "$path" "owner_pid_dead" || return 1
  return 0
}

# Acquire or adopt managed-write lock. Returns 0 on success, 1 on contention/mismatch.
vault_sync_managed_lock_acquire() {
  local repo="${1:-.}"
  local command="${2:-wiki-pull}"
  local path token now inherited attempt

  path="$(vault_sync_managed_lock_path "$repo")" || return 1
  VAULT_SYNC_MANAGED_LOCK_PATH="$path"
  mkdir -p "$(dirname "$path")" || return 1

  inherited="${VAULT_SYNC_MANAGED_LOCK_TOKEN:-}"
  if [ -n "$inherited" ]; then
    if [ -f "$path" ]; then
      token="$(vault_sync_managed_lock_read_token "$path" || true)"
      if [ "$token" = "$inherited" ]; then
        VAULT_SYNC_MANAGED_LOCK_TOKEN_OWNED="$inherited"
        VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE=0
        return 0
      fi
      return 1
    fi
    return 1
  fi

  attempt=0
  while [ "$attempt" -lt 2 ]; do
    attempt=$((attempt + 1))
    token="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
    [ -n "$token" ] || token="$$-$(date +%s)"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if ( set -o noclobber; printf '{"pid":%s,"owner_token":"%s","acquired":"%s","command":"%s"}\n' \
        "$$" "$token" "$now" "$command" >"$path" ) 2>/dev/null; then
      VAULT_SYNC_MANAGED_LOCK_TOKEN_OWNED="$token"
      VAULT_SYNC_MANAGED_LOCK_ACQUIRED="$now"
      VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE=1
      return 0
    fi

    # Contention: only the first pass may reclaim a dead owner, then retry once.
    if [ "$attempt" -eq 1 ]; then
      if vault_sync_managed_lock_reclaim_dead_owner "$repo"; then
        continue
      fi
    fi
    return 1
  done

  return 1
}

vault_sync_managed_lock_release() {
  local path token
  path="${VAULT_SYNC_MANAGED_LOCK_PATH:-}"
  [ -n "$path" ] || return 0
  if [ "${VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE:-0}" != "1" ]; then
    return 0
  fi
  if [ ! -f "$path" ]; then
    VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE=0
    return 0
  fi
  token="$(vault_sync_managed_lock_read_token "$path" || true)"
  if [ "$token" != "${VAULT_SYNC_MANAGED_LOCK_TOKEN_OWNED:-}" ]; then
    return 1
  fi
  rm -f -- "$path"
  VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE=0
  return 0
}
