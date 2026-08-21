#!/usr/bin/env bash
# Regression tests for assert_eq_or_readonly_skew in scripts/e2e-common.sh.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMON_SH="$REPO_ROOT/scripts/e2e-common.sh"

TEST_PASS=0
TEST_FAIL=0

assert_test_pass() {
  local label="$1"
  printf "PASS: %s\n" "$label"
  TEST_PASS=$((TEST_PASS + 1))
}

assert_test_fail() {
  local label="$1"
  local detail="$2"
  printf "FAIL: %s — %s\n" "$label" "$detail"
  TEST_FAIL=$((TEST_FAIL + 1))
}

# 1. equal counts, READONLY_VERIFY unset → PASS+1 FAIL+0, checkmark output
out=$(
  unset READONLY_VERIFY
  source "$COMMON_SH"
  assert_eq_or_readonly_skew "20" "20" "skills match" "skills skew warning" "skills mismatch"
  printf "PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
)
if printf '%s' "$out" | grep -q "PASS=1 FAIL=0" && printf '%s' "$out" | grep -q "skills match"; then
  assert_test_pass "equal counts with READONLY_VERIFY unset increments PASS"
else
  assert_test_fail "equal counts with READONLY_VERIFY unset increments PASS" "output was: $out"
fi

# 2. unequal, READONLY_VERIFY=true → PASS+1 FAIL+0, output contains warning
out=$(
  export READONLY_VERIFY="true"
  source "$COMMON_SH"
  assert_eq_or_readonly_skew "19" "20" "skills match" "skills skew warning" "skills mismatch"
  printf "PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
)
if printf '%s' "$out" | grep -q "PASS=1 FAIL=0" && printf '%s' "$out" | grep -q "skills skew warning"; then
  assert_test_pass "unequal counts with READONLY_VERIFY=true increments PASS with warning"
else
  assert_test_fail "unequal counts with READONLY_VERIFY=true increments PASS with warning" "output was: $out"
fi

# 3. unequal, READONLY_VERIFY=false → PASS+0 FAIL+1, output contains failure
out=$(
  export READONLY_VERIFY="false"
  source "$COMMON_SH"
  assert_eq_or_readonly_skew "19" "20" "skills match" "skills skew warning" "skills mismatch"
  printf "PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
)
if printf '%s' "$out" | grep -q "PASS=0 FAIL=1" && printf '%s' "$out" | grep -q "skills mismatch"; then
  assert_test_pass "unequal counts with READONLY_VERIFY=false increments FAIL"
else
  assert_test_fail "unequal counts with READONLY_VERIFY=false increments FAIL" "output was: $out"
fi

# 4. unequal, READONLY_VERIFY unset → FAIL+1 (full-cycle default)
out=$(
  unset READONLY_VERIFY
  source "$COMMON_SH"
  assert_eq_or_readonly_skew "19" "20" "skills match" "skills skew warning" "skills mismatch"
  printf "PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
)
if printf '%s' "$out" | grep -q "PASS=0 FAIL=1" && printf '%s' "$out" | grep -q "skills mismatch"; then
  assert_test_pass "unequal counts with READONLY_VERIFY unset increments FAIL"
else
  assert_test_fail "unequal counts with READONLY_VERIFY unset increments FAIL" "output was: $out"
fi

printf "\n=== Results: %d passed, %d failed ===\n" "$TEST_PASS" "$TEST_FAIL"
[ "$TEST_FAIL" -eq 0 ] && exit 0 || exit 1
