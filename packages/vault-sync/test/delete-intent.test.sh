#!/bin/bash
# Behavioral tests for delete-intent set planning helpers.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LIB_UNDER_TEST="$REPO_ROOT/packages/vault-sync/scripts/lib/delete-intent.sh"
PASS=0
FAIL=0

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf 'PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s', got '%s'\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_nonzero() {
  local label="$1" rc="$2"
  if [ "$rc" -ne 0 ]; then
    printf 'PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected nonzero exit\n' "$label"
    FAIL=$((FAIL + 1))
  fi
}

# shellcheck source=../scripts/lib/delete-intent.sh
source "$LIB_UNDER_TEST"

test_empty_remote_plan_for_large_active_set() {
  local root active remote planned
  root="$(mktemp -d)"
  active="$root/active.paths"
  remote="$root/remote.paths"
  planned="$root/planned.paths"

  local i
  i=1
  while [ "$i" -le 719 ]; do
    printf 'raw/transcripts/tombstone-%03d.md\n' "$i" >> "$active"
    i=$((i + 1))
  done
  : > "$remote"

  delete_intent_plan_remote_paths "$active" "$remote" > "$planned"
  assert_eq "large-set planner exits successfully" "$?" "0"
  assert_eq "719 absent tombstones produce empty remote plan" "$(wc -l < "$planned" | tr -d ' ')" "0"
  rm -rf "$root"
}

test_sorted_unique_exact_intersection() {
  local root active remote planned expected
  root="$(mktemp -d)"
  active="$root/active.paths"
  remote="$root/remote.paths"
  planned="$root/planned.paths"
  expected="$root/expected.paths"

  printf '%s\n' \
    'notes/zeta.md' \
    'notes/a file.md' \
    'notes/日本語.md' \
    'notes/a.md' \
    'notes/a.md' > "$active"
  printf '%s\n' \
    'notes/a.md.bak' \
    'notes/日本語.md' \
    'notes/a file.md' \
    'notes/a.md' \
    'notes/a file.md' > "$remote"
  LC_ALL=C printf '%s\n' \
    'notes/a file.md' \
    'notes/a.md' \
    'notes/日本語.md' | LC_ALL=C sort -u > "$expected"

  delete_intent_plan_remote_paths "$active" "$remote" > "$planned"
  assert_eq "exact-intersection planner exits successfully" "$?" "0"
  if cmp -s "$planned" "$expected"; then
    printf 'PASS: planner returns sorted unique exact intersection\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: planner intersection mismatch (planned=%s expected=%s)\n' \
      "$(tr '\n' ';' < "$planned")" "$(tr '\n' ';' < "$expected")"
    FAIL=$((FAIL + 1))
  fi

  if ! grep -Fxq 'notes/a.md.bak' "$planned"; then
    printf 'PASS: planner does not prefix-match adjacent paths\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: planner incorrectly prefix-matched notes/a.md.bak\n'
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_missing_inventory_fails_closed() {
  local root active rc
  root="$(mktemp -d)"
  active="$root/active.paths"
  printf 'notes/a.md\n' > "$active"

  delete_intent_plan_remote_paths "$active" "$root/missing.paths" >/dev/null 2>&1
  rc=$?
  assert_nonzero "missing remote inventory fails closed" "$rc"
  rm -rf "$root"
}

test_empty_remote_plan_for_large_active_set
test_sorted_unique_exact_intersection
test_missing_inventory_fails_closed

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
