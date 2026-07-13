#!/bin/bash
# Unit tests for VS_PACKAGE_VERSION / VS_PACKAGE_COMMIT provenance overrides.
#
# Run: bash packages/vault-sync/test/runtime-manifest-provenance.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_MANIFEST_LIB="$VAULT_SYNC_ROOT/scripts/lib/runtime-manifest.sh"
INSTALL_SH="$VAULT_SYNC_ROOT/skills/vault-sync-install/install.sh"

PASS=0
FAIL=0

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# shellcheck source=/dev/null
source "$RUNTIME_MANIFEST_LIB"

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

test_version_override_wins_over_package_json() {
  local root="$TEST_ROOT/pkg-ver"
  mkdir -p "$root"
  printf '%s\n' '{"version":"0.1.0"}' >"$root/package.json"
  local got
  got="$(
    env VS_PACKAGE_VERSION=9.9.9 bash -c '
      # shellcheck source=/dev/null
      source "'"$RUNTIME_MANIFEST_LIB"'"
      vault_sync_package_version "'"$root"'"
    '
  )"
  assert_eq "VS_PACKAGE_VERSION wins over package.json" "$got" "9.9.9"
}

test_empty_version_override_falls_through() {
  local root="$TEST_ROOT/pkg-ver-empty"
  mkdir -p "$root"
  printf '%s\n' '{"version":"0.2.0"}' >"$root/package.json"
  local got
  got="$(
    env VS_PACKAGE_VERSION= bash -c '
      source "'"$RUNTIME_MANIFEST_LIB"'"
      vault_sync_package_version "'"$root"'"
    '
  )"
  assert_eq "empty VS_PACKAGE_VERSION falls through to package.json" "$got" "0.2.0"
}

test_whitespace_version_override_ignored() {
  local root="$TEST_ROOT/pkg-ver-ws"
  mkdir -p "$root"
  printf '%s\n' '{"version":"0.3.0"}' >"$root/package.json"
  local got
  got="$(
    env VS_PACKAGE_VERSION='   ' bash -c '
      source "'"$RUNTIME_MANIFEST_LIB"'"
      vault_sync_package_version "'"$root"'"
    '
  )"
  assert_eq "whitespace VS_PACKAGE_VERSION ignored" "$got" "0.3.0"
}

test_commit_override_without_git() {
  local root="$TEST_ROOT/pkg-commit"
  mkdir -p "$root"
  local got
  got="$(
    env VS_PACKAGE_COMMIT=deadbeefcafebabe bash -c '
      source "'"$RUNTIME_MANIFEST_LIB"'"
      vault_sync_package_commit "'"$root"'"
    '
  )"
  assert_eq "VS_PACKAGE_COMMIT works without git" "$got" "deadbeefcafebabe"
}

test_whitespace_commit_override_ignored() {
  local root="$TEST_ROOT/pkg-commit-ws"
  mkdir -p "$root"
  local got
  got="$(
    env VS_PACKAGE_COMMIT='  ' bash -c '
      source "'"$RUNTIME_MANIFEST_LIB"'"
      vault_sync_package_commit "'"$root"'"
    '
  )"
  # No git in isolated root → empty
  assert_eq "whitespace VS_PACKAGE_COMMIT ignored → empty" "$got" ""
}

test_install_flags_set_env_visible_in_help() {
  local out
  out="$(bash "$INSTALL_SH" --help 2>&1)"
  if printf '%s' "$out" | grep -q 'VS_PACKAGE_VERSION'; then
    printf "PASS: %s\n" "install --help documents VS_PACKAGE_VERSION"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s\n" "install --help documents VS_PACKAGE_VERSION"
    FAIL=$((FAIL + 1))
  fi
  if printf '%s' "$out" | grep -q -- '--package-version'; then
    printf "PASS: %s\n" "install --help documents --package-version"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s\n" "install --help documents --package-version"
    FAIL=$((FAIL + 1))
  fi
}

test_install_flag_exports_for_manifest_helpers() {
  # Flags require values; missing args must hard-fail during parse.
  local rc
  bash "$INSTALL_SH" --package-version >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "PASS: %s\n" "install --package-version requires value"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s\n" "install --package-version requires value"
    FAIL=$((FAIL + 1))
  fi
  bash "$INSTALL_SH" --package-commit >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf "PASS: %s\n" "install --package-commit requires value"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s\n" "install --package-commit requires value"
    FAIL=$((FAIL + 1))
  fi
}

test_version_override_wins_over_package_json
test_empty_version_override_falls_through
test_whitespace_version_override_ignored
test_commit_override_without_git
test_whitespace_commit_override_ignored
test_install_flags_set_env_visible_in_help
test_install_flag_exports_for_manifest_helpers

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
