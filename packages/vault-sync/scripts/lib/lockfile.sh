#!/bin/sh
# lockfile.sh — Advisory locking for vault-sync scripts.
#
# Uses flock when available (Linux primary); falls back to mkdir mutex (macOS).
# Reclaims locks older than max_age seconds (default 600 = 10 min).
#
# Usage:
#   lockfile_acquire <path> [max_age_seconds]   → returns 0 on success, 1 on contention, 2 on stale-reclaim
#   lockfile_release <path>

# Acquire advisory lock.
# Returns: 0 = acquired, 1 = contended, 2 = stale-reclaim
lockfile_acquire() {
  _lock_path="$1"
  _max_age="${2:-600}"

  # Try flock first (Linux primary, macOS opportunistic)
  # shellcheck disable=SC2034
  if command -v flock >/dev/null 2>&1; then
    # Use fd 9 for the lock
    eval "exec 9>\"$_lock_path\""
    if flock -n 9 2>/dev/null; then
      return 0
    fi
    # flock failed — fall through to mkdir mutex
  fi

  # mkdir mutex fallback
  _lock_dir="${_lock_path}.d"
  if mkdir "$_lock_dir" 2>/dev/null; then
    _VS_LOCK_DIR="$_lock_dir"
    export _VS_LOCK_DIR
    trap 'lockfile_release "$_lock_path"' EXIT
    return 0
  fi

  # Directory exists — check if stale
  if [ -d "$_lock_dir" ]; then
    _now=$(date +%s)
    _ctime=$(platform_stat_ctime "$_lock_dir")
    _age=$(( _now - _ctime ))
    if [ "$_age" -gt "$_max_age" ]; then
      # Stale lock — reclaim
      rmdir "$_lock_dir" 2>/dev/null || true
      if mkdir "$_lock_dir" 2>/dev/null; then
        _VS_LOCK_DIR="$_lock_dir"
        export _VS_LOCK_DIR
        trap 'lockfile_release "$_lock_path"' EXIT
        return 2
      fi
    fi
  fi

  return 1
}

# Release advisory lock.
lockfile_release() {
  _lock_path="$1"
  _lock_dir="${_lock_path}.d"

  # Release mkdir mutex if we hold it
  if [ -n "${_VS_LOCK_DIR:-}" ] && [ "$_VS_LOCK_DIR" = "$_lock_dir" ]; then
    rmdir "$_lock_dir" 2>/dev/null || true
    unset _VS_LOCK_DIR
  fi

  # flock is released when fd 9 closes (process exit)
  return 0
}
