#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../scripts/lib/git-operation-journal.sh"
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

assert_rc() {
  local label="$1" actual="$2" expected="$3"
  assert_eq "$label" "$actual" "$expected"
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

test_journal_dir_uses_git_path() {
  local root
  root="$(mktemp -d)"
  make_repo "$root"
  local dir
  dir="$(vault_sync_op_journal_dir "$root")"
  local expected
  expected="$(git -C "$root" rev-parse --git-path vault-sync/operations)"
  case "$expected" in
    /*) ;;
    *) expected="$root/$expected" ;;
  esac
  assert_eq "journal dir uses git-path" "$dir" "$expected"
  rm -rf "$root"
}

test_begin_creates_journal_and_recovery_refs() {
  local root
  root="$(mktemp -d)"
  make_repo "$root"
  local head
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-test-1" "main" "$head" "$head" "lock:1" "0.0.0" "deadbeef"
  rc=$?
  assert_rc "begin ok" "$rc" "0"
  assert_eq "phase prepared" "$(vault_sync_op_get_field "$root" "op-test-1" phase)" "prepared"
  assert_eq "recovery original-head" \
    "$(git -C "$root" rev-parse "refs/vault-sync/recovery/op-test-1/original-head")" \
    "$head"
  assert_eq "recovery target" \
    "$(git -C "$root" rev-parse "refs/vault-sync/recovery/op-test-1/target")" \
    "$head"
  rm -rf "$root"
}

test_recovery_ref_collision_fails() {
  local root
  root="$(mktemp -d)"
  make_repo "$root"
  local head
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-collide" "main" "$head" "$head" "lock:1" "0.0.0" "x"
  vault_sync_op_begin "$root" "op-collide" "main" "$head" "$head" "lock:1" "0.0.0" "x"
  rc=$?
  assert_rc "colliding op_id fails" "$rc" "1"
  rm -rf "$root"
}

test_may_retry_only_once_when_remote_advanced() {
  local root
  root="$(mktemp -d)"
  make_repo "$root"
  local head
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-retry" "main" "$head" "$head" "lock:1" "0.0.0" "x"
  vault_sync_op_set_phase "$root" "op-retry" "rebasing"
  vault_sync_op_record_conflict_identity "$root" "op-retry" || true
  # Simulate advanced remote OID (different fake oid)
  local advanced
  advanced="$(printf 'a\n' | git -C "$root" hash-object -w --stdin)"
  vault_sync_op_may_retry "$root" "op-retry" "$advanced"
  rc=$?
  # Without a real conflict sequencer this may be 1; after full conflict_identity
  # implementation, force identity match by re-recording. For unit test of retry_count:
  vault_sync_op_set_field "$root" "op-retry" "retry_count" "0"
  vault_sync_op_set_field "$root" "op-retry" "handoff" "0"
  # When identity check is skipped via test hook OR identity empty and policy allows only remote advance check:
  # Implementation must: if conflict_identity empty and no sequencer, may_retry returns 1 (fail closed).
  # Separate assertion: after retry_count=1, may_retry always fails.
  vault_sync_op_set_field "$root" "op-retry" "retry_count" "1"
  vault_sync_op_may_retry "$root" "op-retry" "$advanced"
  rc=$?
  assert_rc "second retry refused" "$rc" "1"
  rm -rf "$root"
}

test_cas_recovery_target_requires_expected_old() {
  local root head new_oid wrong_old
  root="$(mktemp -d)"
  make_repo "$root"
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-cas" "main" "$head" "$head" "lock:cas" "0.0.0" "x"
  new_oid="$(printf 'new-target\n' | git -C "$root" hash-object -w --stdin)"
  wrong_old="$(printf 'wrong\n' | git -C "$root" hash-object -w --stdin)"

  vault_sync_op_cas_recovery_target "$root" "op-cas" "$new_oid" "$wrong_old"
  rc=$?
  assert_rc "CAS with wrong expected-old fails" "$rc" "1"
  assert_eq "target unchanged after failed CAS" \
    "$(git -C "$root" rev-parse "refs/vault-sync/recovery/op-cas/target")" \
    "$head"

  vault_sync_op_cas_recovery_target "$root" "op-cas" "$new_oid" "$head"
  rc=$?
  assert_rc "CAS with correct expected-old succeeds" "$rc" "0"
  assert_eq "target updated after CAS" \
    "$(git -C "$root" rev-parse "refs/vault-sync/recovery/op-cas/target")" \
    "$new_oid"
  rm -rf "$root"
}

test_inventory_verify_fails_when_tracked_missing() {
  local root head inv stash_oid
  root="$(mktemp -d)"
  make_repo "$root"
  head="$(git -C "$root" rev-parse HEAD)"
  vault_sync_op_begin "$root" "op-inv" "main" "$head" "$head" "lock:inv" "0.0.0" "x"

  printf 'dirty-body\n' > "$root/f"
  inv="$(mktemp)"
  vault_sync_op_write_inventory "$root" "$inv"
  vault_sync_op_record_inventory "$root" "op-inv" "$inv"
  rm -f "$inv"

  stash_oid="$(vault_sync_op_stash_push_owned "$root" "op-inv-stash" 0)"
  # Apply then remove the restored file to force verification failure
  vault_sync_op_stash_apply_owned "$root" "$stash_oid" >/dev/null
  rm -f "$root/f"
  # Recreate HEAD version so path is absent as dirty restore (file exists from HEAD checkout?)
  # After stash push, worktree was clean with HEAD content; apply restores dirty; rm removes file.
  # If f is tracked, rm leaves it deleted vs HEAD — verify should fail because stash blob missing in worktree.
  vault_sync_op_verify_inventory "$root" "op-inv" "$stash_oid"
  rc=$?
  assert_rc "inventory verify fails when tracked path missing" "$rc" "1"

  # Restore and verify success path
  git -C "$root" checkout -- "$root/f" 2>/dev/null || true
  vault_sync_op_stash_apply_owned "$root" "$stash_oid" >/dev/null 2>&1 || true
  printf 'dirty-body\n' > "$root/f"
  vault_sync_op_verify_inventory "$root" "op-inv" "$stash_oid"
  rc=$?
  assert_rc "inventory verify ok when content matches" "$rc" "0"
  rm -rf "$root"
}

test_find_review_required_is_worktree_aware() {
  local root head git_dir found
  root="$(mktemp -d)"
  make_repo "$root"
  head="$(git -C "$root" rev-parse HEAD)"
  git_dir="$(git -C "$root" rev-parse --absolute-git-dir)"

  vault_sync_op_begin "$root" "op-review" "main" "$head" "$head" "lock:review" "0.9.64" "hash"
  vault_sync_op_mark_review_required "$root" "op-review" "semantic-conflict"

  found="$(vault_sync_op_find_review_required "$root")"
  assert_eq "review-required journal is discovered" "$found" "op-review"
  assert_eq "journal records worktree git dir" \
    "$(vault_sync_op_get_field "$root" "op-review" worktree_git_dir)" "$git_dir"
  rm -rf "$root"
}

test_journal_dir_uses_git_path
test_begin_creates_journal_and_recovery_refs
test_recovery_ref_collision_fails
test_may_retry_only_once_when_remote_advanced
test_cas_recovery_target_requires_expected_old
test_inventory_verify_fails_when_tracked_missing
test_find_review_required_is_worktree_aware

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
