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
# Controllable launchctl stub for vault-sync-install tests.
# Env knobs:
#   TEST_LAUNCHCTL_LOG              append "cmd args" for every call
#   TEST_LAUNCHCTL_ENABLE_LOG       append enable targets only
#   TEST_LAUNCHCTL_DOMAIN_MISSING=1 print gui/$UID fails
#   TEST_LAUNCHCTL_PRINT_RC         fallback label print rc when not tracked (1=absent)
#   TEST_LAUNCHCTL_PRESENT_FILE     newline-separated labels currently registered
#   TEST_LAUNCHCTL_STALE=1          labels never unload (bootout no-op for presence)
#   TEST_LAUNCHCTL_PRINT_ABSENT_N   after bootstrap marks present, first N prints still absent
#   TEST_LAUNCHCTL_PRINT_STATE      counter file for PRINT_ABSENT_N (per-label keys)
#   TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1  every bootstrap exits 5 (no mark present)
#   TEST_LAUNCHCTL_FAIL_FIRST_BOOTSTRAP=1 first bootstrap exits 5, rest succeed
#   TEST_LAUNCHCTL_BOOTSTRAP_EIO_BUT_PRESENT=1 bootstrap exits 5 but marks label present
#   TEST_LAUNCHCTL_STATE            counter file for FAIL_FIRST
#   TEST_LAUNCHCTL_BOOTOUT_MODE     service|plistpath (informational)

cmd="$1"
shift || true

if [ -n "${TEST_LAUNCHCTL_LOG:-}" ]; then
  printf '%s\n' "$cmd${*:+ $*}" >> "$TEST_LAUNCHCTL_LOG"
fi

# Default presence tracker so successful bootstrap becomes observable.
present_file="${TEST_LAUNCHCTL_PRESENT_FILE:-${TMPDIR:-/tmp}/vault-sync-launchctl-present-default}"
print_state="${TEST_LAUNCHCTL_PRINT_STATE:-${TMPDIR:-/tmp}/vault-sync-launchctl-print-state}"

label_is_present() {
  _lbl="$1"
  [ -f "$present_file" ] && grep -qxF "$_lbl" "$present_file" 2>/dev/null
}

mark_label_present() {
  _lbl="$1"
  touch "$present_file"
  if ! grep -qxF "$_lbl" "$present_file" 2>/dev/null; then
    printf '%s\n' "$_lbl" >> "$present_file"
  fi
}

clear_label_present() {
  _lbl="$1"
  if [ -f "$present_file" ]; then
    _tmp="$(mktemp)"
    grep -vxF "$_lbl" "$present_file" > "$_tmp" 2>/dev/null || true
    mv "$_tmp" "$present_file"
  fi
}

case "$cmd" in
  print)
    target="${1:-}"
    case "$target" in
      gui/*/*)
        label="${target##*/}"
        # Stale mode: always present (never unloads).
        if [ "${TEST_LAUNCHCTL_STALE:-0}" = "1" ] || [ "${TEST_LAUNCHCTL_PRINT_RC:-}" = "0" ]; then
          # PRINT_RC=0 retained for backward-compat with older tests.
          if [ "${TEST_LAUNCHCTL_STALE:-0}" = "1" ] || { [ "${TEST_LAUNCHCTL_PRINT_RC:-}" = "0" ] && [ -z "${TEST_LAUNCHCTL_PRESENT_FILE:-}" ]; }; then
            exit 0
          fi
        fi
        if label_is_present "$label"; then
          # Delayed observability after successful registration.
          if [ -n "${TEST_LAUNCHCTL_PRINT_ABSENT_N:-}" ]; then
            count=0
            if [ -f "$print_state" ]; then
              # format: label count pairs — use simple global counter for tests
              count="$(cat "$print_state" 2>/dev/null || echo 0)"
            fi
            # Only count prints while present (post-bootstrap).
            count=$((count + 1))
            printf '%s\n' "$count" > "$print_state"
            if [ "$count" -le "${TEST_LAUNCHCTL_PRINT_ABSENT_N}" ]; then
              exit 1
            fi
          fi
          exit 0
        fi
        exit "${TEST_LAUNCHCTL_PRINT_RC:-1}"
        ;;
      gui/*)
        if [ "${TEST_LAUNCHCTL_DOMAIN_MISSING:-0}" = "1" ]; then
          echo "Could not find domain $target" >&2
          exit 1
        fi
        exit 0
        ;;
      *)
        exit "${TEST_LAUNCHCTL_PRINT_RC:-1}"
        ;;
    esac
    ;;

  bootout)
    target="${1:-}"
    if [ "${TEST_LAUNCHCTL_STALE:-0}" = "1" ]; then
      exit 0
    fi
    # Legacy stale via PRINT_RC=0 without PRESENT_FILE tracking
    if [ "${TEST_LAUNCHCTL_PRINT_RC:-}" = "0" ] && [ -z "${TEST_LAUNCHCTL_PRESENT_FILE:-}" ]; then
      exit 0
    fi
    case "$target" in
      gui/*/*)
        label="${target##*/}"
        clear_label_present "$label"
        ;;
      gui/*)
        # domain + plist path form: clear all tracked labels
        : > "$present_file"
        ;;
    esac
    exit 0
    ;;

  enable)
    if [ -n "${TEST_LAUNCHCTL_ENABLE_LOG:-}" ]; then
      printf '%s\n' "$*" >> "$TEST_LAUNCHCTL_ENABLE_LOG"
    fi
    exit 0
    ;;

  bootstrap)
    domain="${1:-}"
    plist="${2:-}"
    label=""
    if [ -n "$plist" ] && [ -f "$plist" ]; then
      label="$(sed -n 's/.*<string>\(com\.karlchow\.[^<]*\)<\/string>.*/\1/p' "$plist" | head -n 1)"
    fi
    if [ -z "$label" ]; then
      base="$(basename "$plist" .plist 2>/dev/null || echo unknown)"
      label="$base"
    fi

    if [ "${TEST_LAUNCHCTL_BOOTSTRAP_EIO_BUT_PRESENT:-0}" = "1" ]; then
      mark_label_present "$label"
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi

    if [ "${TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP:-0}" = "1" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi

    if [ "${TEST_LAUNCHCTL_FAIL_FIRST_BOOTSTRAP:-0}" = "1" ]; then
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

    mark_label_present "$label"
    exit 0
    ;;

  *)
    exit 0
    ;;
esac
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
# Allow rev-parse HEAD for runtime-manifest package_commit.
if [ "$1" = "-C" ]; then
  shift 2
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  echo "deadbeefcafebabe000000000000000000000001"
  exit 0
fi
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

# Isolate launchctl presence tracker per run_install invocation.
fresh_launchctl_state() {
  if [ -z "${TEST_LAUNCHCTL_PRESENT_FILE:-}" ]; then
    export TEST_LAUNCHCTL_PRESENT_FILE="$TEST_ROOT/launchctl-present.$$.$RANDOM"
    : > "$TEST_LAUNCHCTL_PRESENT_FILE"
  else
    # Caller-owned tracker: ensure parent dir exists; do not truncate (may seed labels).
    mkdir -p "$(dirname "$TEST_LAUNCHCTL_PRESENT_FILE")"
    touch "$TEST_LAUNCHCTL_PRESENT_FILE"
  fi
  if [ -z "${TEST_LAUNCHCTL_PRINT_STATE:-}" ]; then
    export TEST_LAUNCHCTL_PRINT_STATE="$TEST_ROOT/launchctl-print-state.$$.$RANDOM"
    rm -f "$TEST_LAUNCHCTL_PRINT_STATE"
  fi
}

run_install() {
  local out_file="$1"
  shift
  local fake_bin="$TEST_ROOT/fake-bin"
  make_fake_bin "$fake_bin"
  fresh_launchctl_state

  HOME="$TEST_ROOT/home" \
  USER=root \
  PATH="$fake_bin:${TEST_EXTRA_PATH:+$TEST_EXTRA_PATH:}/usr/bin:/bin:/usr/sbin:/sbin" \
  VS_HOSTNAME=pvelxc-test \
  VS_LAUNCHD_UNLOAD_DEADLINE_S="${VS_LAUNCHD_UNLOAD_DEADLINE_S:-1}" \
  VS_LAUNCHD_PRESENT_POLL_MAX="${VS_LAUNCHD_PRESENT_POLL_MAX:-5}" \
  TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
  TEST_LAUNCHCTL_PRINT_STATE="${TEST_LAUNCHCTL_PRINT_STATE:-}" \
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

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — missing file %s\n" "$label" "$path"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s' got '%s'\n" "$label" "$expected" "$actual"
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

# Runtime manifest after successful macOS install
MANIFEST="$TEST_ROOT/home/Library/Application Support/vault-sync/runtime-manifest.json"
assert_file_exists "manifest exists after macOS install" "$MANIFEST"
assert_contains "manifest has package_version" "$MANIFEST" "package_version"
assert_contains "manifest has schema_version" "$MANIFEST" "schema_version"
assert_contains "manifest has files map" "$MANIFEST" "bin/wiki-pull-with-auto-resolve.sh"
assert_contains "manifest has push plist hash entry" "$MANIFEST" "LaunchAgents/com.karlchow.wiki-push.plist"
# sha256 hex is 64 chars; require at least one 64-hex token in files values
if python3 -c 'import json,re,sys; m=json.load(open(sys.argv[1])); vals=list(m.get("files",{}).values()); sys.exit(0 if vals and all(re.fullmatch(r"[0-9a-f]{64}", v) for v in vals) else 1)' "$MANIFEST" 2>/dev/null; then
  printf "PASS: %s\n" "manifest file hashes are sha256 hex"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "manifest file hashes are sha256 hex"
  cat "$MANIFEST" 2>/dev/null || true
  FAIL=$((FAIL + 1))
fi

MAC_RETRY_OUT="$TEST_ROOT/macos-retry.out"
MAC_RETRY_LOG="$TEST_ROOT/macos-retry.launchctl.log"
MAC_RETRY_STATE="$TEST_ROOT/macos-retry.state"
rm -f "$MAC_RETRY_STATE"
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
MAC_STALE_PRESENT="$TEST_ROOT/macos-stale.present"
printf '%s\n' "com.karlchow.wiki-push" "com.karlchow.wiki-fetch" > "$MAC_STALE_PRESENT"
TEST_UNAME_S=Darwin \
TEST_EXTRA_PATH="$NODE_DIR" \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_STALE=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$MAC_STALE_PRESENT" \
TEST_LAUNCHCTL_LOG="$MAC_STALE_LOG" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
run_install "$MAC_STALE_OUT" --role leaf --execute
MAC_STALE_RC=$?
assert_exit "macOS install fails when stale loaded label never reloads" "$MAC_STALE_RC" 1
assert_contains "macOS stale label warning is explicit" "$MAC_STALE_OUT" "registration still present after bootout"
assert_contains "macOS stale bootstrap failure is reported" "$MAC_STALE_OUT" "failed to load launchd unit com.karlchow.wiki-push"

# --- Scenario 12: bootstrap EIO but label present after proven absence → accept, no second bootstrap ---
MAC12_OUT="$TEST_ROOT/macos-12-eio-present.out"
MAC12_LOG="$TEST_ROOT/macos-12.launchctl.log"
MAC12_PRESENT="$TEST_ROOT/macos-12.present"
rm -f "$MAC12_PRESENT" "$MAC12_LOG"
TEST_UNAME_S=Darwin \
TEST_EXTRA_PATH="$NODE_DIR" \
TEST_LAUNCHCTL_BOOTSTRAP_EIO_BUT_PRESENT=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$MAC12_PRESENT" \
TEST_LAUNCHCTL_LOG="$MAC12_LOG" \
run_install "$MAC12_OUT" --role leaf --execute
MAC12_RC=$?
assert_exit "12: bootstrap EIO with label present succeeds" "$MAC12_RC" 0
assert_contains "12: surfaces reconcile warning" "$MAC12_OUT" "label present"
PUSH_BOOTSTRAP_COUNT="$(grep -c "bootstrap gui/$UID $TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-push.plist" "$MAC12_LOG" || true)"
assert_eq "12: no second bootstrap spam for push" "$PUSH_BOOTSTRAP_COUNT" "1"

# --- Scenario 13: bootstrap rc=0 but print absent briefly then present → poll succeeds ---
MAC13_OUT="$TEST_ROOT/macos-13-poll.out"
MAC13_PRINT_STATE="$TEST_ROOT/macos-13.print-state"
rm -f "$MAC13_PRINT_STATE"
TEST_UNAME_S=Darwin \
TEST_EXTRA_PATH="$NODE_DIR" \
TEST_LAUNCHCTL_PRINT_ABSENT_N=2 \
TEST_LAUNCHCTL_PRINT_STATE="$MAC13_PRINT_STATE" \
VS_LAUNCHD_PRESENT_POLL_MAX=10 \
run_install "$MAC13_OUT" --role leaf --execute
MAC13_RC=$?
assert_exit "13: success-not-yet-observable poll succeeds" "$MAC13_RC" 0

# --- Scenario 14: domain missing → fatal before plist replace ---
MAC14_HOME="$TEST_ROOT/macos-14-home"
mkdir -p "$MAC14_HOME/Library/LaunchAgents"
# Seed a sentinel that must not be overwritten when domain is missing.
printf 'SENTINEL_OLD_PLIST\n' > "$MAC14_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
MAC14_OUT="$TEST_ROOT/macos-14-domain.out"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC14_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_LAUNCHCTL_DOMAIN_MISSING=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
bash "$INSTALL_SH" --role leaf --execute >"$MAC14_OUT" 2>&1
MAC14_RC=$?
assert_exit "14: domain missing fails install" "$MAC14_RC" 1
assert_contains "14: domain missing message" "$MAC14_OUT" "launchd gui domain missing"
assert_contains "14: sentinel plist not replaced" "$MAC14_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist" "SENTINEL_OLD_PLIST"

# --- Scenario 15: enable called before bootstrap ---
MAC15_OUT="$TEST_ROOT/macos-15-enable.out"
MAC15_LOG="$TEST_ROOT/macos-15.launchctl.log"
rm -f "$MAC15_LOG"
TEST_UNAME_S=Darwin \
TEST_EXTRA_PATH="$NODE_DIR" \
TEST_LAUNCHCTL_LOG="$MAC15_LOG" \
run_install "$MAC15_OUT" --role leaf --execute
MAC15_RC=$?
assert_exit "15: enable-normalization install succeeds" "$MAC15_RC" 0
assert_contains "15: enable push target" "$MAC15_LOG" "enable gui/$UID/com.karlchow.wiki-push"
assert_order "15: enable before bootstrap for push" "$MAC15_LOG" \
  "enable gui/$UID/com.karlchow.wiki-push" \
  "bootstrap gui/$UID $TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-push.plist"

# --- Scenario 16a: rollback restores old plist on repeated failure ---
MAC16A_HOME="$TEST_ROOT/macos-16a-home"
mkdir -p "$MAC16A_HOME/Library/LaunchAgents"
printf 'OLD_PUSH_BODY_16A\n' > "$MAC16A_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
printf 'OLD_FETCH_BODY_16A\n' > "$MAC16A_HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist"
MAC16A_OUT="$TEST_ROOT/macos-16a.out"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC16A_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_PRINT_RC=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
VS_LAUNCHD_PRESENT_POLL_MAX=2 \
bash "$INSTALL_SH" --role leaf --execute >"$MAC16A_OUT" 2>&1
MAC16A_RC=$?
assert_exit "16a: repeated bootstrap failure fails install" "$MAC16A_RC" 1
assert_contains "16a: rollback restored old push plist" "$MAC16A_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist" "OLD_PUSH_BODY_16A"
# Rollback artifacts retained under cache
if ls -d "$MAC16A_HOME/Library/Caches/vault-sync/install-rollback/"* >/dev/null 2>&1; then
  printf "PASS: %s\n" "16a: rollback artifacts retained after failure"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "16a: rollback artifacts retained after failure"
  FAIL=$((FAIL + 1))
fi

# --- Scenario 16b: rollback bootstrap failure surfaces error ---
MAC16B_OUT="$TEST_ROOT/macos-16b.out"
MAC16B_HOME="$TEST_ROOT/macos-16b-home"
mkdir -p "$MAC16B_HOME/Library/LaunchAgents"
printf 'OLD_PUSH_BODY_16B\n' > "$MAC16B_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC16B_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_PRINT_RC=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
VS_LAUNCHD_PRESENT_POLL_MAX=2 \
bash "$INSTALL_SH" --role leaf --execute >"$MAC16B_OUT" 2>&1
MAC16B_RC=$?
assert_exit "16b: rollback path still fails install" "$MAC16B_RC" 1
assert_contains "16b: surfaces bootstrap/load failure" "$MAC16B_OUT" "failed to load launchd unit com.karlchow.wiki-push"
assert_contains "16b: surfaces launchctl stderr" "$MAC16B_OUT" "Bootstrap failed: 5: Input/output error"

# Rollback artifacts retained after successful install (must not delete on success)
MAC_RB_OUT="$TEST_ROOT/macos-rollback-keep.out"
# Force a path that creates rollback dirs: re-install when plists already exist
TEST_UNAME_S=Darwin TEST_EXTRA_PATH="$NODE_DIR" run_install "$MAC_RB_OUT" --role leaf --execute
# Second install should also leave rollback dirs (old plists saved)
TEST_UNAME_S=Darwin TEST_EXTRA_PATH="$NODE_DIR" run_install "$MAC_RB_OUT" --role leaf --execute
MAC_RB_RC=$?
assert_exit "success path still exits 0 on reinstall" "$MAC_RB_RC" 0
if ls -d "$TEST_ROOT/home/Library/Caches/vault-sync/install-rollback/"* >/dev/null 2>&1; then
  printf "PASS: %s\n" "rollback artifacts kept after successful reinstall"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "rollback artifacts kept after successful reinstall"
  FAIL=$((FAIL + 1))
fi

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
