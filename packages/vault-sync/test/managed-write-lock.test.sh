#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../scripts/lib/managed-write-lock.sh"
JOURNAL_LIB="$SCRIPT_DIR/../scripts/lib/git-operation-journal.sh"
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

write_managed_lock() {
  local root="$1" pid="$2" token="${3:-testtoken}" path
  path="$(vault_sync_managed_lock_path "$root")"
  mkdir -p "$(dirname "$path")"
  printf '{"pid":%s,"owner_token":"%s","acquired":"2026-07-24T03:10:03Z","command":"wiki-pull"}\n' \
    "$pid" "$token" >"$path"
}

attempt_managed_lock_acquire() (
  local root="$1" command="${2:-contender}"
  # Re-source only the lock library to reset its process-local ownership globals.
  # shellcheck source=/dev/null
  . "$LIB"
  vault_sync_managed_lock_acquire "$root" "$command"
)

# shellcheck source=/dev/null
. "$JOURNAL_LIB"
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
  local root path git_dir head
  root="$(mktemp -d)"
  make_repo "$root"
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-rebase-review" "main" "$head" "$head" "lock:test" "test" "x"
  vault_sync_op_mark_review_required "$root" "op-rebase-review" "semantic-conflict"
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
  assert_eq "rebase review journal remains open" \
    "$(vault_sync_op_get_field "$root" "op-rebase-review" phase)" "review-required"
  rm -rf "$root"
}

test_dead_owner_not_reclaimed_during_merge_sequencer() {
  local root path git_dir
  root="$(mktemp -d)"
  make_repo "$root"
  path="$(vault_sync_managed_lock_path "$root")"
  write_managed_lock "$root" 999999999 deadtoken
  git_dir="$(git -C "$root" rev-parse --git-dir)"
  case "$git_dir" in
    /*) ;;
    *) git_dir="$root/$git_dir" ;;
  esac
  printf '%040d\n' 0 >"$git_dir/MERGE_HEAD"
  attempt_managed_lock_acquire "$root"
  assert_eq "dead owner not reclaimed during merge sequencer" "$?" "1"
  assert_eq "lock remains during merge sequencer" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  rm -rf "$root"
}

test_dead_owner_and_resolved_review_recover_in_one_acquire() {
  local root path base rec_count
  root="$(mktemp -d)"
  make_repo "$root"
  base="$(git -C "$root" rev-parse HEAD)"
  printf 'advanced\n' >"$root/f"
  git -C "$root" commit -am advance >/dev/null
  vault_sync_op_begin "$root" "op-resolved-review" "main" "$base" "$base" "lock:test" "test" "x"
  vault_sync_op_mark_review_required "$root" "op-resolved-review" "semantic-conflict-or-stale-exhausted"
  # Preserve unrelated authored WIP: target ancestry + idle Git state is the proof.
  printf 'unrelated-wip\n' >"$root/wip.md"

  path="$(vault_sync_managed_lock_path "$root")"
  write_managed_lock "$root" 999999999 deadtoken

  vault_sync_managed_lock_acquire "$root" "page-publish"
  assert_eq "resolved review plus dead owner recovers in one acquire" "$?" "0"
  assert_eq "resolved review journal completed" \
    "$(vault_sync_op_get_field "$root" "op-resolved-review" phase)" "complete"
  assert_eq "resolved review reason recorded" \
    "$(vault_sync_op_get_field "$root" "op-resolved-review" reason)" "superseded-stale-review-required"
  assert_eq "resolved review prior reason preserved" \
    "$(vault_sync_op_get_field "$root" "op-resolved-review" prior_reason)" "semantic-conflict-or-stale-exhausted"
  assert_eq "new owner lock acquired" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  rec_count="$(find "$(dirname "$path")/recovery" -type f -name 'stale-managed-write-lock-*.json' 2>/dev/null | wc -l | tr -d ' ')"
  assert_eq "dead owner recovery preserved after journal supersede" "$rec_count" "1"
  vault_sync_managed_lock_release
  rm -rf "$root"
}

test_live_owner_keeps_resolved_review_open() {
  local root path head
  root="$(mktemp -d)"
  make_repo "$root"
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-live-review" "main" "$head" "$head" "lock:test" "test" "x"
  vault_sync_op_mark_review_required "$root" "op-live-review" "semantic-conflict"
  path="$(vault_sync_managed_lock_path "$root")"
  write_managed_lock "$root" "$$" livetoken
  attempt_managed_lock_acquire "$root"
  assert_eq "live owner still refuses resolved review recovery" "$?" "1"
  assert_eq "live owner leaves review journal open" \
    "$(vault_sync_op_get_field "$root" "op-live-review" phase)" "review-required"
  rm -rf "$root"
}

test_unmerged_state_keeps_review_and_dead_lock() {
  local root path base
  root="$(mktemp -d)"
  make_repo "$root"
  base="$(git -C "$root" rev-parse HEAD)"
  git -C "$root" checkout -b theirs >/dev/null
  printf 'theirs\n' >"$root/f"
  git -C "$root" commit -am theirs >/dev/null
  git -C "$root" checkout main >/dev/null
  printf 'ours\n' >"$root/f"
  git -C "$root" commit -am ours >/dev/null
  git -C "$root" merge theirs >/dev/null 2>&1 || true
  vault_sync_op_begin "$root" "op-unmerged-review" "main" "$(git -C "$root" rev-parse HEAD)" "$base" "lock:test" "test" "x"
  vault_sync_op_mark_review_required "$root" "op-unmerged-review" "semantic-conflict"
  path="$(vault_sync_managed_lock_path "$root")"
  write_managed_lock "$root" 999999999 deadtoken
  attempt_managed_lock_acquire "$root"
  assert_eq "unmerged state refuses dead owner recovery" "$?" "1"
  assert_eq "unmerged state keeps review journal open" \
    "$(vault_sync_op_get_field "$root" "op-unmerged-review" phase)" "review-required"
  assert_eq "unmerged state keeps dead lock" "$( [ -f "$path" ] && echo yes || echo no )" "yes"
  rm -rf "$root"
}

test_fresh_acquire_and_release
test_contention
test_matching_inherited_token
test_mismatched_inherited_token
test_dead_owner_reclaim_preserves_recovery
test_live_owner_not_reclaimed
test_dead_owner_not_reclaimed_during_rebase
test_dead_owner_not_reclaimed_during_merge_sequencer
test_dead_owner_and_resolved_review_recover_in_one_acquire
test_live_owner_keeps_resolved_review_open
test_unmerged_state_keeps_review_and_dead_lock

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
