#!/bin/bash
# managed-write-lock.sh — shared CLI/shell managed-write lock (Bash 3.2).
# Source from vault-sync scripts. Lock path: git --git-path vault-sync/managed-write.lock

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

# Acquire or adopt managed-write lock. Returns 0 on success, 1 on contention/mismatch.
vault_sync_managed_lock_acquire() {
  local repo="${1:-.}"
  local command="${2:-wiki-pull}"
  local path token now inherited
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
