#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../scripts/lib/managed-write-lock.sh"
PASS=0
FAIL=0

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s', got '%s'\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

make_repo() {
  local root="$1"
  mkdir -p "$root"
  git -C "$root" init >/dev/null
  git -C "$root" branch -M main
  git -C "$root" config user.email t@t
  git -C "$root" config user.name t
  printf 'x\n' > "$root/f"
  git -C "$root" add f
  git -C "$root" commit -m init >/dev/null
}

# shellcheck source=/dev/null
. "$LIB"

test_fresh_acquire_and_release() {
  local root path
  root="$(mktemp -d)"
  make_repo "$root"
  vault_sync_managed_lock_acquire "$root" "test" || true
  assert_eq "fresh acquire ok" "$?" "0"
  path="$(vault_sync_managed_lock_path "$root")"
  assert_eq "lock file exists" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  vault_sync_managed_lock_release
  assert_eq "release removes lock" "$( [ -f "$path" ] && echo yes || echo no )" "no"
  rm -rf "$root"
}

test_contention() {
  local root
  root="$(mktemp -d)"
  make_repo "$root"
  vault_sync_managed_lock_acquire "$root" "holder"
  (
    # shellcheck source=/dev/null
    . "$LIB"
    vault_sync_managed_lock_acquire "$root" "contender"
  )
  assert_eq "second acquire fails" "$?" "1"
  vault_sync_managed_lock_release
  rm -rf "$root"
}

test_matching_inherited_token() {
  local root path token
  root="$(mktemp -d)"
  make_repo "$root"
  vault_sync_managed_lock_acquire "$root" "cli"
  path="$(vault_sync_managed_lock_path "$root")"
  token="$(vault_sync_managed_lock_read_token "$path")"
  (
    # shellcheck source=/dev/null
    . "$LIB"
    VAULT_SYNC_MANAGED_LOCK_TOKEN="$token" vault_sync_managed_lock_acquire "$root" "helper"
    assert_eq "inherited matching token accepted" "$?" "0"
    assert_eq "helper does not own release" "$VAULT_SYNC_MANAGED_LOCK_OWNS_RELEASE" "0"
  )
  vault_sync_managed_lock_release
  rm -rf "$root"
}

test_mismatched_inherited_token() {
  local root
  root="$(mktemp -d)"
  make_repo "$root"
  vault_sync_managed_lock_acquire "$root" "cli"
  (
    # shellcheck source=/dev/null
    . "$LIB"
    VAULT_SYNC_MANAGED_LOCK_TOKEN="deadbeef" vault_sync_managed_lock_acquire "$root" "helper"
  )
  assert_eq "mismatched inherited token refused" "$?" "1"
  vault_sync_managed_lock_release
  rm -rf "$root"
}

test_dead_owner_reclaim_preserves_recovery() {
  local root path rec_count
  root="$(mktemp -d)"
  make_repo "$root"
  path="$(vault_sync_managed_lock_path "$root")"
  mkdir -p "$(dirname "$path")"
  # Impossible PID on Unix — never a live process we own.
  printf '{"pid":999999999,"owner_token":"deadtoken","acquired":"2026-07-17T00:00:00Z","command":"wiki-pull"}\n' >"$path"
  vault_sync_managed_lock_acquire "$root" "reclaimer"
  assert_eq "dead owner reclaimed" "$?" "0"
  assert_eq "new lock present" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  rec_count="$(find "$(dirname "$path")/recovery" -type f -name 'stale-managed-write-lock-*.json' 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "recovery record written" "$rec_count" "1"
  vault_sync_managed_lock_release
  assert_eq "release clears reclaimed lock" "$( [ -f "$path" ] && echo yes || echo no )" "no"
  rm -rf "$root"
}

test_live_owner_not_reclaimed() {
  local root path
  root="$(mktemp -d)"
  make_repo "$root"
  path="$(vault_sync_managed_lock_path "$root")"
  mkdir -p "$(dirname "$path")"
  printf '{"pid":%s,"owner_token":"livetoken","acquired":"2026-07-17T00:00:00Z","command":"wiki-pull"}\n' "$$" >"$path"
  (
    # shellcheck source=/dev/null
    . "$LIB"
    vault_sync_managed_lock_acquire "$root" "contender"
  )
  assert_eq "live owner not reclaimed" "$?" "1"
  assert_eq "live lock still present" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  rm -f "$path"
  rm -rf "$root"
}

test_dead_owner_not_reclaimed_during_rebase() {
  local root path git_dir
  root="$(mktemp -d)"
  make_repo "$root"
  path="$(vault_sync_managed_lock_path "$root")"
  mkdir -p "$(dirname "$path")"
  printf '{"pid":999999999,"owner_token":"deadtoken","acquired":"2026-07-17T00:00:00Z","command":"wiki-pull"}\n' >"$path"
  git_dir="$(git -C "$root" rev-parse --git-dir)"
  case "$git_dir" in
    /*) ;;
    *) git_dir="$root/$git_dir" ;;
  esac
  mkdir -p "$git_dir/rebase-merge"
  (
    # shellcheck source=/dev/null
    . "$LIB"
    vault_sync_managed_lock_acquire "$root" "contender"
  )
  assert_eq "dead owner not reclaimed during rebase" "$?" "1"
  assert_eq "lock remains during rebase" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  rm -rf "$root"
}

test_fresh_acquire_and_release
test_contention
test_matching_inherited_token
test_mismatched_inherited_token
test_dead_owner_reclaim_preserves_recovery
test_live_owner_not_reclaimed
test_dead_owner_not_reclaimed_during_rebase

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
