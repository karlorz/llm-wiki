#!/bin/bash
# Regression tests for packages/vault-sync/skills/vault-sync-uninstall/uninstall.sh.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNINSTALL_SH="$SCRIPT_DIR/../skills/vault-sync-uninstall/uninstall.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

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

HOME_DIR="$TEST_ROOT/home"
PROJECTION="$TEST_ROOT/wiki-fetch"
FAKE_BIN="$TEST_ROOT/bin"
mkdir -p \
  "$HOME_DIR/.skillwiki" \
  "$HOME_DIR/.local/share/vault-sync/bin" \
  "$PROJECTION/.git" \
  "$FAKE_BIN"

printf '%s\n' \
  'vault_sync.installed=true' \
  'vault_sync.role=leaf' \
  'vault_sync.service_scope=user' \
  "vault_sync.fetch_projection=$PROJECTION" \
  > "$HOME_DIR/.skillwiki/.env"
printf '%s\n' 'preserve projection' > "$PROJECTION/sentinel.txt"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$HOME_DIR/.local/share/vault-sync/bin/wiki-push.sh"
chmod +x "$HOME_DIR/.local/share/vault-sync/bin/wiki-push.sh"

printf '%s\n' '#!/bin/sh' 'printf "Linux\n"' > "$FAKE_BIN/uname"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$FAKE_BIN/systemctl"
printf '%s\n' '#!/bin/sh' 'printf "leaf-test\n"' > "$FAKE_BIN/hostname"
chmod +x "$FAKE_BIN"/*

OUT="$TEST_ROOT/uninstall.out"
HOME="$HOME_DIR" \
PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=leaf-test \
bash "$UNINSTALL_SH" > "$OUT" 2>&1
RC=$?

assert_eq "uninstall exits 0" "$RC" "0"
assert_eq \
  "uninstall clears fetch projection config" \
  "$(awk -F= '$1=="vault_sync.fetch_projection" {print $2}' "$HOME_DIR/.skillwiki/.env")" \
  "none"
assert_eq \
  "uninstall preserves the independent projection clone" \
  "$(cat "$PROJECTION/sentinel.txt" 2>/dev/null || true)" \
  "preserve projection"

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
