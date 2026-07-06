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
  echo "${TEST_UNAME_S:-Linux}"
else
  /usr/bin/uname "$@"
fi
EOF

  cat > "$bin_dir/launchctl" <<'EOF'
#!/bin/sh
if [ "${TEST_LAUNCHCTL_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$TEST_LAUNCHCTL_LOG"
fi

if [ "$1" = "print" ]; then
  exit "${TEST_LAUNCHCTL_PRINT_RC:-1}"
fi

if [ "${TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP:-0}" = "1" ] && [ "$1" = "bootstrap" ]; then
  echo "Bootstrap failed: 5: Input/output error" >&2
  exit 5
fi

if [ "${TEST_LAUNCHCTL_FAIL_FIRST_BOOTSTRAP:-0}" = "1" ] && [ "$1" = "bootstrap" ]; then
  state="${TEST_LAUNCHCTL_STATE:-/tmp/vault-sync-launchctl-state}"
  count=0
  [ -f "$state" ] && count="$(cat "$state")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$state"
  if [ "$count" -eq 1 ]; then
    echo "Bootstrap failed: 5: Input/output error" >&2
    exit 5
  fi
fi

exit 0
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
  PATH="$fake_bin:${TEST_EXTRA_PATH:+$TEST_EXTRA_PATH:}/usr/bin:/bin:/usr/sbin:/sbin" \
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

FULL_OUT="$TEST_ROOT/full.out"
run_install "$FULL_OUT" --role leaf --dry-run
FULL_RC=$?
assert_exit "full dry-run exits 0" "$FULL_RC" 0
assert_contains "full install deploys presync helper" "$FULL_OUT" "wiki-sync.sh"
assert_contains "full install repairs convenience wiki-sync symlink" "$FULL_OUT" "ln -sfn"
assert_contains "full install targets home bin wiki-sync" "$FULL_OUT" "$TEST_ROOT/home/bin/wiki-sync.sh"
assert_contains "full leaf install enables push fetch and fuse timers" "$FULL_OUT" "systemctl --user enable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer"

SNAPSHOT_OUT="$TEST_ROOT/snapshotter.out"
run_install "$SNAPSHOT_OUT" --role snapshotter --service-scope system --dry-run
SNAPSHOT_RC=$?
assert_exit "snapshotter dry-run exits 0" "$SNAPSHOT_RC" 0
assert_contains "snapshotter plan targets system units" "$SNAPSHOT_OUT" "/etc/systemd/system"
assert_contains "snapshotter renders snapshot service" "$SNAPSHOT_OUT" "wiki-snapshot.service"
assert_contains "snapshotter renders snapshot timer" "$SNAPSHOT_OUT" "wiki-snapshot.timer"
assert_contains "snapshotter enables snapshot and fuse timers" "$SNAPSHOT_OUT" "systemctl enable --now wiki-snapshot.timer wiki-fuse-refresh.timer"
assert_contains "snapshotter records service scope" "$SNAPSHOT_OUT" "set config: vault_sync.service_scope=system"
assert_contains "snapshotter records snapshot profile" "$SNAPSHOT_OUT" "set config: vault_sync.snapshot_profile=/etc/vault-sync/profiles/pvelxc-test-snapshotter.env"
assert_contains "snapshotter records snapshot script" "$SNAPSHOT_OUT" "set config: vault_sync.snapshot_script=$TEST_ROOT/home/.local/share/vault-sync/bin/wiki-snapshot.sh"
assert_not_contains "snapshotter does not install push unit" "$SNAPSHOT_OUT" "wiki-push.service"
assert_not_contains "snapshotter does not install fetch unit" "$SNAPSHOT_OUT" "wiki-fetch.service"
assert_contains "snapshot service exports HOME" "$SCRIPT_DIR/../service-units/systemd/wiki-snapshot.service" "Environment=HOME=@HOME@"
assert_contains "snapshot service reads conventional profile path" "$SCRIPT_DIR/../service-units/systemd/wiki-snapshot.service" "EnvironmentFile=-/etc/vault-sync/profiles/%H-snapshotter.env"
assert_contains "snapshot timer runs every 30 minutes" "$SCRIPT_DIR/../service-units/systemd/wiki-snapshot.timer" "OnCalendar=*-*-* *:02,32:00"

NODE_DIR="$TEST_ROOT/node24/bin"
mkdir -p "$NODE_DIR"
cat > "$NODE_DIR/node" <<'EOF'
#!/bin/sh
echo v24.15.0
EOF
chmod +x "$NODE_DIR/node"

MAC_OUT="$TEST_ROOT/macos-full.out"
TEST_UNAME_S=Darwin TEST_EXTRA_PATH="$NODE_DIR" run_install "$MAC_OUT" --role leaf --execute
MAC_RC=$?
PUSH_PLIST="$TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-push.plist"
assert_exit "macOS full install exits 0" "$MAC_RC" 0
assert_contains "macOS push plist includes discovered node dir" "$PUSH_PLIST" "$NODE_DIR"
assert_contains "macOS push plist keeps Homebrew fallback" "$PUSH_PLIST" "/opt/homebrew/bin"
assert_contains "macOS push plist keeps system fallback" "$PUSH_PLIST" "/usr/bin:/bin"

MAC_RETRY_OUT="$TEST_ROOT/macos-retry.out"
MAC_RETRY_LOG="$TEST_ROOT/macos-retry.launchctl.log"
MAC_RETRY_STATE="$TEST_ROOT/macos-retry.state"
TEST_UNAME_S=Darwin \
TEST_EXTRA_PATH="$NODE_DIR" \
TEST_LAUNCHCTL_FAIL_FIRST_BOOTSTRAP=1 \
TEST_LAUNCHCTL_LOG="$MAC_RETRY_LOG" \
TEST_LAUNCHCTL_STATE="$MAC_RETRY_STATE" \
run_install "$MAC_RETRY_OUT" --role leaf --execute
MAC_RETRY_RC=$?
assert_exit "macOS install retries transient bootstrap EIO" "$MAC_RETRY_RC" 0
assert_contains "macOS retry surfaces bootstrap warning" "$MAC_RETRY_OUT" "launchctl bootstrap failed for com.karlchow.wiki-push on attempt 1; retrying"
assert_contains "macOS retry captures launchctl stderr" "$MAC_RETRY_OUT" "Bootstrap failed: 5: Input/output error"
assert_contains "macOS retry eventually bootstraps push unit" "$MAC_RETRY_LOG" "bootstrap gui/$UID $TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-push.plist"
assert_contains "macOS retry bootstraps fetch unit" "$MAC_RETRY_LOG" "bootstrap gui/$UID $TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-fetch.plist"

MAC_STALE_OUT="$TEST_ROOT/macos-stale-label.out"
MAC_STALE_LOG="$TEST_ROOT/macos-stale-label.launchctl.log"
TEST_UNAME_S=Darwin \
TEST_EXTRA_PATH="$NODE_DIR" \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_PRINT_RC=0 \
TEST_LAUNCHCTL_LOG="$MAC_STALE_LOG" \
run_install "$MAC_STALE_OUT" --role leaf --execute
MAC_STALE_RC=$?
assert_exit "macOS install fails when stale loaded label never reloads" "$MAC_STALE_RC" 1
assert_contains "macOS stale label warning is explicit" "$MAC_STALE_OUT" "launchd label com.karlchow.wiki-push still appears loaded after bootout"
assert_contains "macOS stale bootstrap failure is reported" "$MAC_STALE_OUT" "failed to load launchd unit com.karlchow.wiki-push"

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
