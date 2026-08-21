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

# ro_mode: UNSET | true | false
run_skew_case() {
  local ro_mode="$1" actual="$2" expected="$3" want_pf="$4" want_msg="$5" label="$6"
  local out
  out=$(
    if [ "$ro_mode" = "UNSET" ]; then
      unset READONLY_VERIFY
    else
      export READONLY_VERIFY="$ro_mode"
    fi
    # shellcheck source=../e2e-common.sh
    source "$COMMON_SH"
    assert_eq_or_readonly_skew "$actual" "$expected" "skills match" "skills skew warning" "skills mismatch"
    printf "PASS=%d FAIL=%d\n" "$PASS" "$FAIL"
  )
  if printf '%s' "$out" | grep -q "$want_pf" && printf '%s' "$out" | grep -q "$want_msg"; then
    assert_test_pass "$label"
  else
    assert_test_fail "$label" "output was: $out"
  fi
}

run_skew_case UNSET "20" "20" "PASS=1 FAIL=0" "skills match" \
  "equal counts with READONLY_VERIFY unset increments PASS"
run_skew_case true "19" "20" "PASS=1 FAIL=0" "skills skew warning" \
  "unequal counts with READONLY_VERIFY=true increments PASS with warning"
run_skew_case false "19" "20" "PASS=0 FAIL=1" "skills mismatch" \
  "unequal counts with READONLY_VERIFY=false increments FAIL"
run_skew_case UNSET "19" "20" "PASS=0 FAIL=1" "skills mismatch" \
  "unequal counts with READONLY_VERIFY unset increments FAIL"

printf "\n=== Results: %d passed, %d failed ===\n" "$TEST_PASS" "$TEST_FAIL"
[ "$TEST_FAIL" -eq 0 ] && exit 0 || exit 1
