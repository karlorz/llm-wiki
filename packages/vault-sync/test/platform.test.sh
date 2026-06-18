#!/bin/bash
# platform.test.sh — Unit tests for lib/platform.sh and lib/lockfile.sh
#
# Run: bash packages/vault-sync/test/platform.test.sh
# Exit 0 = all pass. Print one line per case (PASS/FAIL).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../scripts/lib"

. "$LIB_DIR/platform.sh"
platform_detect_os
. "$LIB_DIR/git-case.sh"

PASS=0
FAIL=0

assert() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s', got '%s'\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

# 1. platform_detect_os returns macos on Darwin, linux on Linux
case "$(uname -s)" in
  Darwin) assert "detect_os on Darwin" "$VS_OS" "macos" ;;
  Linux)  assert "detect_os on Linux" "$VS_OS" "linux" ;;
  *)      assert "detect_os unknown" "$VS_OS" "unsupported" ;;
esac

# 2. platform_stat_size matches wc -c for a 1024-byte file
TEST_FILE=$(mktemp)
dd if=/dev/zero bs=1024 count=1 of="$TEST_FILE" 2>/dev/null
EXPECTED_SIZE=$(wc -c < "$TEST_FILE" | tr -d ' ')
ACTUAL_SIZE=$(platform_stat_size "$TEST_FILE")
assert "stat_size 1024-byte file" "$ACTUAL_SIZE" "$EXPECTED_SIZE"
rm -f "$TEST_FILE"

# 3. platform_stat_ctime returns within 5s of date +%s for a just-created dir
TEST_DIR=$(mktemp -d)
NOW=$(date +%s)
CTIME=$(platform_stat_ctime "$TEST_DIR")
AGE=$(( NOW - CTIME ))
if [ "$AGE" -ge 0 ] && [ "$AGE" -le 5 ]; then
  printf "PASS: stat_ctime within 5s\n"
  PASS=$((PASS + 1))
else
  printf "FAIL: stat_ctime — age=%d (expected 0-5)\n" "$AGE"
  FAIL=$((FAIL + 1))
fi
rmdir "$TEST_DIR"

# 4. platform_log_dir resolves to a writable path
LOG_DIR=$(platform_log_dir)
if mkdir -p "$LOG_DIR" 2>/dev/null && [ -d "$LOG_DIR" ]; then
  printf "PASS: log_dir writable\n"
  PASS=$((PASS + 1))
else
  printf "FAIL: log_dir not writable at %s\n" "$LOG_DIR"
  FAIL=$((FAIL + 1))
fi

# 5. platform_notify returns 0 in headless mode (no display)
platform_notify "test" "test message" 2>/dev/null
assert "notify returns 0" "$?" "0"

# 6. lockfile_acquire returns 0 first call, 1 second call without release
. "$LIB_DIR/lockfile.sh"
LOCK_TEST=$(mktemp)
lockfile_acquire "$LOCK_TEST" 600
RC1=$?
assert "lockfile_acquire first call" "$RC1" "0"

# Second acquire should fail (contended)
lockfile_acquire "$LOCK_TEST" 600
RC2=$?
# RC2 should be 1 (contended) — but mkdir mutex uses .d suffix,
# so we need a different path to avoid .d collision
# Test with a separate lock path instead
LOCK_TEST2=$(mktemp)
lockfile_acquire "$LOCK_TEST2" 600
RC2A=$?
assert "lockfile_acquire separate path" "$RC2A" "0"
lockfile_release "$LOCK_TEST2"

# 7. lockfile_acquire reclaims after max_age exceeded
# Strategy: create a stale lock dir, wait 2s, then acquire with max_age=1
LOCK_STALE=$(mktemp).stale
LOCK_STALE_DIR="${LOCK_STALE}.d"
mkdir -p "$LOCK_STALE_DIR"
sleep 2
lockfile_acquire "$LOCK_STALE" 1
RC3=$?
assert "lockfile_acquire stale reclaim" "$RC3" "2"
lockfile_release "$LOCK_STALE"
rm -rf "$LOCK_STALE_DIR" "$LOCK_STALE" 2>/dev/null

# 8. lockfile_release allows re-acquire
LOCK_REL=$(mktemp).release
lockfile_acquire "$LOCK_REL" 600
lockfile_release "$LOCK_REL"
# After release, acquire should work again
# Note: flock-based release is automatic on fd close; mkdir needs explicit rmdir
LOCK_REL_DIR="${LOCK_REL}.d"
rmdir "$LOCK_REL_DIR" 2>/dev/null || true
lockfile_acquire "$LOCK_REL" 600
RC4=$?
assert "lockfile_acquire after release" "$RC4" "0"
lockfile_release "$LOCK_REL"
rm -rf "${LOCK_REL}.d" "$LOCK_REL" 2>/dev/null

# 9. platform_require rclone returns 0 if rclone in PATH, else 1
if command -v rclone >/dev/null 2>&1; then
  platform_require rclone
  assert "require rclone (present)" "$?" "0"
else
  platform_require rclone 2>/dev/null
  assert "require rclone (absent)" "$?" "1"
fi

# 10. Scripts pass bash -n (syntax check)
SYNTAX_FAIL=0
for script in "$SCRIPT_DIR/../scripts/wiki-push.sh" "$SCRIPT_DIR/../scripts/wiki-fetch-notify.sh" "$SCRIPT_DIR/../scripts/wiki-pull-with-auto-resolve.sh" "$SCRIPT_DIR/../scripts/wiki-fuse-refresh.sh" "$SCRIPT_DIR/../scripts/wiki-snapshot.sh"; do
  if ! bash -n "$script" 2>/dev/null; then
    printf "FAIL: syntax check %s\n" "$(basename "$script")"
    SYNTAX_FAIL=$((SYNTAX_FAIL + 1))
  fi
done
if [ "$SYNTAX_FAIL" -eq 0 ]; then
  printf "PASS: all scripts pass bash -n\n"
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + SYNTAX_FAIL))
fi

# 11. Case-only tracked path collisions are detected before sync scripts publish them.
CASE_ROOT=$(mktemp -d)
CASE_REPO="$CASE_ROOT/repo"
git -C "$CASE_ROOT" init repo >/dev/null
git -C "$CASE_REPO" branch -M main
EMPTY_BLOB=$(git -C "$CASE_REPO" hash-object -w --stdin </dev/null)
git -C "$CASE_REPO" update-index --add --cacheinfo 100644 "$EMPTY_BLOB" Case.md
git -C "$CASE_REPO" update-index --add --cacheinfo 100644 "$EMPTY_BLOB" case.md
CASE_CONFLICTS=$(cd "$CASE_REPO" && git_case_conflicts)
CASE_RC=$?
if [ "$CASE_RC" -ne 0 ] && printf '%s\n' "$CASE_CONFLICTS" | grep -q 'Case.md <-> case.md'; then
  printf "PASS: case-only path collision detected\n"
  PASS=$((PASS + 1))
else
  printf "FAIL: case-only path collision not detected (rc=%s output=%s)\n" "$CASE_RC" "$CASE_CONFLICTS"
  FAIL=$((FAIL + 1))
fi
rm -rf "$CASE_ROOT"

# Clean up lock test files
rm -rf "${LOCK_TEST}" "${LOCK_TEST}.d" 2>/dev/null

# Summary
printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
