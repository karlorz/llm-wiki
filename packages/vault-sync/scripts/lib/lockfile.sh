#!/bin/sh
# Cooperative directory mutex, plus flock for compatibility with older shell users.
# One active lock per shell. max_age is accepted for API compatibility only:
# age cannot prove an owner dead, and unknown/legacy directory owners fail closed.
# Returns 0 on acquisition, 1 on contention (legacy return 2 remains reserved).
lockfile_acquire() {
  [ -z "${_VS_LOCK_DIR:-}" ] || return 1
  _lock_path="$1"
  _lock_dir="${_lock_path}.d"
  mkdir "$_lock_dir" 2>/dev/null || return 1
  _VS_LOCK_TOKEN="${BASHPID:-$$}-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  if ! printf '%s\n' "$_VS_LOCK_TOKEN" > "$_lock_dir/owner"; then
    rmdir "$_lock_dir" 2>/dev/null || true
    return 1
  fi
  if command -v flock >/dev/null 2>&1; then
    # Failure is contention, never permission to bypass flock with mkdir.
    if ! { exec 9>"$_lock_path"; } || ! flock -n 9 2>/dev/null; then
      exec 9>&-
      rm -f "$_lock_dir/owner"
      rmdir "$_lock_dir" 2>/dev/null || true
      return 1
    fi
    _VS_FLOCK_PATH="$_lock_path"
  fi
  _VS_LOCK_DIR="$_lock_dir"
  # Preserve caller cleanup (e.g. managed-write lock release).
  if [ -z "$(trap)" ]; then
    trap '[ -z "${_VS_LOCK_DIR:-}" ] || lockfile_release "${_VS_LOCK_DIR%.d}"' EXIT
  fi
  return 0
}

lockfile_release() {
  _lock_dir="${1}.d"
  if [ "${_VS_LOCK_DIR:-}" = "$_lock_dir" ]; then
    # No automatic reclaim: a replacement/unknown owner must never be removed.
    if [ "${_VS_LOCK_TOKEN%%-*}" = "${BASHPID:-$$}" ] &&
       [ "$(cat "$_lock_dir/owner" 2>/dev/null)" = "${_VS_LOCK_TOKEN:-}" ]; then
      rm -f "$_lock_dir/owner"
      rmdir "$_lock_dir" 2>/dev/null || true
    fi
    if [ "${_VS_FLOCK_PATH:-}" = "$1" ]; then
      exec 9>&-
      unset _VS_FLOCK_PATH
    fi
    unset _VS_LOCK_DIR _VS_LOCK_TOKEN
  fi
  return 0
}
