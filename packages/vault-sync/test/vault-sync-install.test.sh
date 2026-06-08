#!/bin/bash
# Regression tests for packages/vault-sync/skills/vault-sync-install/install.sh.
#
# Run: bash packages/vault-sync/test/vault-sync-install.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/../skills/vault-sync-install/install.sh"

PASS=0
FAIL=0

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

make_fake_bin() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"

  cat > "$bin_dir/uname" <<'EOF'
#!/bin/sh
if [ "$1" = "-s" ]; then
  echo Linux
else
  /usr/bin/uname "$@"
fi
EOF

  cat > "$bin_dir/systemctl" <<'EOF'
#!/bin/sh
exit 0
EOF

  cat > "$bin_dir/loginctl" <<'EOF'
#!/bin/sh
exit 0
EOF

  cat > "$bin_dir/git" <<'EOF'
#!/bin/sh
exit 0
EOF

  cat > "$bin_dir/rclone" <<'EOF'
#!/bin/sh
exit 0
EOF

  cat > "$bin_dir/hostname" <<'EOF'
#!/bin/sh
echo pvelxc-test
EOF

  cat > "$bin_dir/id" <<'EOF'
#!/bin/sh
if [ "$1" = "-u" ]; then
  echo 0
else
  /usr/bin/id "$@"
fi
EOF

  cat > "$bin_dir/findmnt" <<'EOF'
#!/bin/sh
if [ "${TEST_FINDMNT_FSTYPE:-fuse.rclone}" = "missing" ]; then
  exit 1
fi
echo "${TEST_FINDMNT_FSTYPE:-fuse.rclone}"
EOF

  chmod +x "$bin_dir"/*
}

run_install() {
  local out_file="$1"
  shift
  local fake_bin="$TEST_ROOT/fake-bin"
  make_fake_bin "$fake_bin"

  HOME="$TEST_ROOT/home" \
  USER=root \
  PATH="$fake_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  VS_HOSTNAME=pvelxc-test \
  bash "$INSTALL_SH" "$@" >"$out_file" 2>&1
}

assert_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -Fq "$needle" "$file"; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — missing '%s'\n" "$label" "$needle"
    printf "%s\n" "--- output ---"
    cat "$file"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -Fq "$needle" "$file"; then
    printf "FAIL: %s — unexpected '%s'\n" "$label" "$needle"
    printf "%s\n" "--- output ---"
    cat "$file"
    FAIL=$((FAIL + 1))
  else
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  fi
}

assert_exit() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" -eq "$expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected rc=%s got rc=%s\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_order() {
  local label="$1" file="$2" first="$3" second="$4"
  local first_line second_line
  first_line="$(grep -Fn "$first" "$file" | head -n 1 | cut -d: -f1)"
  second_line="$(grep -Fn "$second" "$file" | head -n 1 | cut -d: -f1)"

  if [ -n "$first_line" ] && [ -n "$second_line" ] && [ "$first_line" -lt "$second_line" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s' before '%s'\n" "$label" "$first" "$second"
    printf "%s\n" "--- output ---"
    cat "$file"
    FAIL=$((FAIL + 1))
  fi
}

FUSE_OUT="$TEST_ROOT/fuse-only.out"
run_install "$FUSE_OUT" --mode fuse-only --service-scope system --vault-path "$TEST_ROOT/wiki" --dry-run
FUSE_RC=$?
assert_exit "fuse-only dry-run exits 0 on fuse.rclone vault" "$FUSE_RC" 0
assert_contains "fuse-only uses system unit directory" "$FUSE_OUT" "/etc/systemd/system"
assert_contains "fuse-only installs fuse refresh service" "$FUSE_OUT" "wiki-fuse-refresh.service"
assert_contains "fuse-only enables only fuse timer" "$FUSE_OUT" "systemctl daemon-reload"
assert_contains "fuse-only marks fuse refresh config" "$FUSE_OUT" "set config: vault_sync.fuse_refresh_enabled=true"
assert_not_contains "fuse-only does not install push unit" "$FUSE_OUT" "wiki-push.service"
assert_not_contains "fuse-only does not install fetch unit" "$FUSE_OUT" "wiki-fetch.service"
assert_not_contains "fuse-only does not enable push timer" "$FUSE_OUT" "wiki-push.timer"
assert_not_contains "fuse-only does not enable fetch timer" "$FUSE_OUT" "wiki-fetch.timer"
assert_not_contains "fuse-only does not deploy push filter" "$FUSE_OUT" "wiki-push-filters.txt"
assert_not_contains "fuse-only does not mark full vault-sync installed" "$FUSE_OUT" "set config: vault_sync.installed=true"
assert_contains "fuse refresh service exports HOME" "$SCRIPT_DIR/../service-units/systemd/wiki-fuse-refresh.service" "Environment=HOME=@HOME@"
assert_order "fuse-only validates helper before enabling timer" "$FUSE_OUT" "wiki-fuse-refresh.sh --dry-run --max-dir-cache" "systemctl enable --now wiki-fuse-refresh.timer"

NON_FUSE_OUT="$TEST_ROOT/non-fuse.out"
TEST_FINDMNT_FSTYPE=ext4 run_install "$NON_FUSE_OUT" --mode fuse-only --service-scope system --vault-path "$TEST_ROOT/wiki" --dry-run
NON_FUSE_RC=$?
assert_exit "fuse-only refuses non-rclone-fuse vault" "$NON_FUSE_RC" 1
assert_contains "fuse-only names rejected fs type" "$NON_FUSE_OUT" "is not fuse.rclone"
assert_not_contains "fuse-only refusal does not plan unit install" "$NON_FUSE_OUT" "wiki-fuse-refresh.timer"

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
