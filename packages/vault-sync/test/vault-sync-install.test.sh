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
if [ -n "${TEST_SYSTEMCTL_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$TEST_SYSTEMCTL_LOG"
fi
case " $* " in
  *" is-active --quiet wiki-fetch.timer "*)
    [ "${TEST_SYSTEMCTL_FETCH_ACTIVE:-0}" = "1" ] && exit 0
    exit 1
    ;;
  *" is-active --quiet wiki-fetch.service "*)
    [ "${TEST_SYSTEMCTL_FETCH_SERVICE_ACTIVE:-0}" = "1" ] && exit 0
    exit 1
    ;;
  *" is-enabled --quiet wiki-fetch.timer "*)
    [ "${TEST_SYSTEMCTL_FETCH_ENABLED:-0}" = "1" ] && exit 0
    exit 1
    ;;
  *" stop wiki-fetch.timer wiki-fetch.service "*|*" disable wiki-fetch.timer "*)
    [ "${TEST_SYSTEMCTL_MISSING_FETCH_UNITS:-0}" = "1" ] && exit 5
    ;;
esac
case " $* " in
  *" enable --now "*)
    if [ "${TEST_SYSTEMCTL_FAIL_ENABLE:-0}" = "1" ] && printf '%s\n' "$*" | grep -q 'wiki-push.timer'; then
      echo "simulated systemctl enable failure" >&2
      exit 1
    fi
    ;;
esac
exit 0
EOF

  cat > "$bin_dir/loginctl" <<'EOF'
#!/bin/sh
exit 0
EOF

  cat > "$bin_dir/git" <<'EOF'
#!/bin/sh
if [ "${TEST_REAL_GIT:-0}" = "1" ]; then
  exec "${TEST_REAL_GIT_BIN:-/usr/bin/git}" "$@"
fi
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

  cat > "$bin_dir/cp" <<'EOF'
#!/bin/sh
# Fail only the installer rollback-artifact copy when requested. All ordinary
# package and fixture copies remain delegated to the platform cp.
destination=""
for argument in "$@"; do
  destination="$argument"
done
case "$destination" in
  */install-rollback/*)
    if [ "${TEST_CP_FAIL_ROLLBACK:-0}" = "1" ]; then
      echo "simulated rollback cp failure" >&2
      exit 1
    fi
    ;;
esac
case "${1:-}" in
  */install-rollback/*)
    if [ "${TEST_CP_FAIL_RESTORE:-0}" = "1" ]; then
      echo "simulated rollback restore cp failure" >&2
      exit 1
    fi
    ;;
esac
exec /bin/cp "$@"
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
  if grep -Fq -- "$needle" "$file"; then
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
  if grep -Fq -- "$needle" "$file"; then
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

write_valid_launchd_plist() {
  local path="$1" label="$2" marker="${3:-}"
  mkdir -p "$(dirname "$path")"
  cat > "$path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- $marker -->
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>/tmp/wiki-sync-test.sh</string></array>
</dict></plist>
EOF
}

make_projection_remote() {
  local fixture_root="$1"
  local seed="$fixture_root/seed"
  local remote="$fixture_root/remote.git"

  mkdir -p "$seed"
  "$REAL_GIT" -C "$seed" init -q -b main
  "$REAL_GIT" -C "$seed" config user.name "Vault Sync Test"
  "$REAL_GIT" -C "$seed" config user.email "vault-sync-test@example.invalid"
  printf '%s\n' '# Test schema' > "$seed/SCHEMA.md"
  mkdir -p "$seed/concepts"
  printf '%s\n' '# Kept note' > "$seed/concepts/kept.md"
  "$REAL_GIT" -C "$seed" add SCHEMA.md concepts/kept.md
  "$REAL_GIT" -C "$seed" commit -qm "seed projection"
  "$REAL_GIT" clone -q --bare "$seed" "$remote"
  printf '%s\n' "$remote"
}

REAL_GIT="$(command -v git)"

HELP_OUT="$TEST_ROOT/help.out"
run_install "$HELP_OUT" --help
HELP_RC=$?
assert_exit "help exits 0" "$HELP_RC" 0
assert_contains "help documents fetch projection option" "$HELP_OUT" "--fetch-projection <absolute-path>"
assert_contains "help documents fetch projection environment override" "$HELP_OUT" "VS_FETCH_PROJECTION=<absolute-path>"

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

FETCH_PROJECTION_DRY_RUN_OUT="$TEST_ROOT/fetch-projection-dry-run.out"
FETCH_PROJECTION_DRY_RUN_PATH="$TEST_ROOT/wiki-fetch"
run_install "$FETCH_PROJECTION_DRY_RUN_OUT" \
  --role leaf \
  --vault-path "$TEST_ROOT/wiki" \
  --fetch-projection "$FETCH_PROJECTION_DRY_RUN_PATH" \
  --dry-run
FETCH_PROJECTION_DRY_RUN_RC=$?
assert_exit "fetch projection dry-run exits 0" "$FETCH_PROJECTION_DRY_RUN_RC" 0
assert_contains "fetch projection dry-run plans validation or bootstrap" "$FETCH_PROJECTION_DRY_RUN_OUT" "Plan: prepare fetch projection at $FETCH_PROJECTION_DRY_RUN_PATH"
assert_contains "fetch projection dry-run plans config before service activation" "$FETCH_PROJECTION_DRY_RUN_OUT" "set config: vault_sync.fetch_projection=$FETCH_PROJECTION_DRY_RUN_PATH"
if [ ! -e "$FETCH_PROJECTION_DRY_RUN_PATH" ]; then
  printf "PASS: %s\n" "fetch projection dry-run creates no target directory"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "fetch projection dry-run creates no target directory"
  FAIL=$((FAIL + 1))
fi

RELATIVE_FETCH_PROJECTION_OUT="$TEST_ROOT/fetch-projection-relative.out"
run_install "$RELATIVE_FETCH_PROJECTION_OUT" --role leaf --fetch-projection wiki-fetch --dry-run
RELATIVE_FETCH_PROJECTION_RC=$?
assert_exit "fetch projection rejects a relative path" "$RELATIVE_FETCH_PROJECTION_RC" 1
assert_contains "relative fetch projection rejection is explicit" "$RELATIVE_FETCH_PROJECTION_OUT" "fetch projection path must be absolute"

SAME_FETCH_PROJECTION_OUT="$TEST_ROOT/fetch-projection-same.out"
run_install "$SAME_FETCH_PROJECTION_OUT" \
  --role leaf \
  --vault-path "$TEST_ROOT/wiki" \
  --fetch-projection "$TEST_ROOT/wiki" \
  --dry-run
SAME_FETCH_PROJECTION_RC=$?
assert_exit "fetch projection rejects the live vault path" "$SAME_FETCH_PROJECTION_RC" 1
assert_contains "same fetch projection rejection is explicit" "$SAME_FETCH_PROJECTION_OUT" "fetch projection must be distinct from live vault"

mkdir -p "$TEST_ROOT/wiki/nested-projection"
NESTED_FETCH_PROJECTION_OUT="$TEST_ROOT/fetch-projection-nested.out"
run_install "$NESTED_FETCH_PROJECTION_OUT" \
  --role leaf \
  --vault-path "$TEST_ROOT/wiki" \
  --fetch-projection "$TEST_ROOT/wiki/nested-projection" \
  --dry-run
NESTED_FETCH_PROJECTION_RC=$?
assert_exit "fetch projection rejects a path inside the live vault" "$NESTED_FETCH_PROJECTION_RC" 1
assert_contains "nested fetch projection rejection is explicit" "$NESTED_FETCH_PROJECTION_OUT" "fetch projection and live vault must not be nested"

LIVE_INSIDE_PROJECTION_OUT="$TEST_ROOT/live-inside-projection.out"
run_install "$LIVE_INSIDE_PROJECTION_OUT" \
  --role leaf \
  --vault-path "$TEST_ROOT/projection-parent/live" \
  --fetch-projection "$TEST_ROOT/projection-parent" \
  --dry-run
LIVE_INSIDE_PROJECTION_RC=$?
assert_exit "fetch projection rejects a live vault nested inside it" "$LIVE_INSIDE_PROJECTION_RC" 1
assert_contains "reverse nesting rejection is explicit" "$LIVE_INSIDE_PROJECTION_OUT" "fetch projection and live vault must not be nested"

SNAPSHOTTER_FETCH_PROJECTION_OUT="$TEST_ROOT/snapshotter-fetch-projection.out"
run_install "$SNAPSHOTTER_FETCH_PROJECTION_OUT" \
  --role snapshotter \
  --service-scope system \
  --fetch-projection "$TEST_ROOT/wiki-fetch" \
  --dry-run
SNAPSHOTTER_FETCH_PROJECTION_RC=$?
assert_exit "snapshotter role rejects a fetch projection" "$SNAPSHOTTER_FETCH_PROJECTION_RC" 1
assert_contains "snapshotter fetch projection rejection is explicit" "$SNAPSHOTTER_FETCH_PROJECTION_OUT" "fetch projection is supported only for full leaf installs"

PROJECTION_FIXTURE_ROOT="$TEST_ROOT/projection-fixture"
PROJECTION_REMOTE="$(make_projection_remote "$PROJECTION_FIXTURE_ROOT")"
PROJECTION_LIVE="$TEST_ROOT/projection-live"
PROJECTION_TARGET="$TEST_ROOT/projection-git"
"$REAL_GIT" clone -q "$PROJECTION_REMOTE" "$PROJECTION_LIVE"
PROJECTION_INSTALL_OUT="$TEST_ROOT/projection-install.out"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
run_install "$PROJECTION_INSTALL_OUT" \
  --role leaf \
  --vault-path "$PROJECTION_LIVE" \
  --fetch-projection "$PROJECTION_TARGET" \
  --execute
PROJECTION_INSTALL_RC=$?
assert_exit "missing fetch projection is bootstrapped from the live origin" "$PROJECTION_INSTALL_RC" 0
if [ -d "$PROJECTION_TARGET/.git" ]; then
  printf "PASS: %s\n" "fetch projection bootstrap creates an independent clone"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "fetch projection bootstrap creates an independent clone"
  FAIL=$((FAIL + 1))
fi
assert_contains "fetch projection bootstrap keeps promotable content" "$PROJECTION_TARGET/concepts/kept.md" "# Kept note"
assert_contains "fetch projection bootstrap persists config" "$TEST_ROOT/home/.skillwiki/.env" "vault_sync.fetch_projection=$PROJECTION_TARGET"
assert_contains "fetch projection bootstrap reports validation" "$PROJECTION_INSTALL_OUT" "Validated fetch projection: $PROJECTION_TARGET"
"$REAL_GIT" -C "$PROJECTION_TARGET" add -A
assert_eq \
  "git add -A in projection cannot stage event ledger paths" \
  "$("$REAL_GIT" -C "$PROJECTION_TARGET" diff --cached --name-only -- meta/log-events)" \
  ""

FRESH_PROJECTION_TARGET="$TEST_ROOT/projection-fresh-git"
FRESH_PROJECTION_OUT="$TEST_ROOT/projection-fresh-install.out"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
TEST_SYSTEMCTL_MISSING_FETCH_UNITS=1 \
run_install "$FRESH_PROJECTION_OUT" \
  --role leaf \
  --vault-path "$PROJECTION_LIVE" \
  --fetch-projection "$FRESH_PROJECTION_TARGET" \
  --execute
FRESH_PROJECTION_RC=$?
assert_exit "fresh Linux projection install tolerates absent old fetch units" "$FRESH_PROJECTION_RC" 0

SNAPSHOT_COLLISION_PATH="$TEST_ROOT/snapshot-projection"
mkdir -p "$TEST_ROOT/home/.skillwiki"
printf '%s\n' "vault_sync.snapshot_worktree=$SNAPSHOT_COLLISION_PATH" >> "$TEST_ROOT/home/.skillwiki/.env"
SNAPSHOT_COLLISION_OUT="$TEST_ROOT/fetch-snapshot-collision.out"
run_install "$SNAPSHOT_COLLISION_OUT" \
  --role leaf \
  --vault-path "$PROJECTION_LIVE" \
  --fetch-projection "$SNAPSHOT_COLLISION_PATH" \
  --dry-run
SNAPSHOT_COLLISION_RC=$?
assert_exit "fetch projection rejects the configured snapshot worktree" "$SNAPSHOT_COLLISION_RC" 1
assert_contains "snapshot worktree collision rejection is explicit" "$SNAPSHOT_COLLISION_OUT" "fetch projection must not reuse vault_sync.snapshot_worktree"

ROLLBACK_FIXTURE_ROOT="$TEST_ROOT/projection-rollback-fixture"
ROLLBACK_REMOTE="$(make_projection_remote "$ROLLBACK_FIXTURE_ROOT")"
ROLLBACK_LIVE="$TEST_ROOT/projection-rollback-live"
ROLLBACK_TARGET="$TEST_ROOT/projection-rollback-git"
"$REAL_GIT" clone -q "$ROLLBACK_REMOTE" "$ROLLBACK_LIVE"
ROLLBACK_INSTALL_OUT="$TEST_ROOT/projection-rollback-install.out"
ROLLBACK_SYSTEMCTL_LOG="$TEST_ROOT/projection-rollback-systemctl.log"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
TEST_SYSTEMCTL_FAIL_ENABLE=1 \
TEST_SYSTEMCTL_FETCH_ACTIVE=1 \
TEST_SYSTEMCTL_FETCH_ENABLED=1 \
TEST_SYSTEMCTL_LOG="$ROLLBACK_SYSTEMCTL_LOG" \
run_install "$ROLLBACK_INSTALL_OUT" \
  --role leaf \
  --vault-path "$ROLLBACK_LIVE" \
  --fetch-projection "$ROLLBACK_TARGET" \
  --execute
ROLLBACK_INSTALL_RC=$?
assert_exit "service activation failure fails projection install" "$ROLLBACK_INSTALL_RC" 1
if [ ! -e "$ROLLBACK_TARGET" ]; then
  printf "PASS: %s\n" "failed install rolls back a newly created projection"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "failed install rolls back a newly created projection"
  FAIL=$((FAIL + 1))
fi
assert_contains "failed install restores prior fetch projection config" "$TEST_ROOT/home/.skillwiki/.env" "vault_sync.fetch_projection=$FRESH_PROJECTION_TARGET"
assert_not_contains "failed install removes attempted fetch projection config" "$TEST_ROOT/home/.skillwiki/.env" "vault_sync.fetch_projection=$ROLLBACK_TARGET"
assert_contains "projection migration stops the prior fetch timer" "$ROLLBACK_SYSTEMCTL_LOG" "--user stop wiki-fetch.timer wiki-fetch.service"
assert_contains "failed projection migration restores the prior fetch timer" "$ROLLBACK_SYSTEMCTL_LOG" "--user enable --now wiki-fetch.timer"
assert_order "projection migration stops fetch before validating the clone" "$ROLLBACK_INSTALL_OUT" "Stopped existing fetch service before projection migration" "Validated fetch projection: $ROLLBACK_TARGET"
assert_order "projection migration acquires the managed-write lock before validating the clone" "$ROLLBACK_INSTALL_OUT" "Acquired live-vault managed-write lock for fetch projection migration" "Validated fetch projection: $ROLLBACK_TARGET"

INACTIVE_ROLLBACK_TARGET="$TEST_ROOT/projection-enabled-inactive-git"
INACTIVE_ROLLBACK_OUT="$TEST_ROOT/projection-enabled-inactive-install.out"
INACTIVE_ROLLBACK_SYSTEMCTL_LOG="$TEST_ROOT/projection-enabled-inactive-systemctl.log"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
TEST_SYSTEMCTL_FAIL_ENABLE=1 \
TEST_SYSTEMCTL_FETCH_ACTIVE=0 \
TEST_SYSTEMCTL_FETCH_ENABLED=1 \
TEST_SYSTEMCTL_LOG="$INACTIVE_ROLLBACK_SYSTEMCTL_LOG" \
run_install "$INACTIVE_ROLLBACK_OUT" \
  --role leaf \
  --vault-path "$PROJECTION_LIVE" \
  --fetch-projection "$INACTIVE_ROLLBACK_TARGET" \
  --execute
INACTIVE_ROLLBACK_RC=$?
assert_exit "activation failure still fails for an enabled inactive prior timer" "$INACTIVE_ROLLBACK_RC" 1
assert_contains "rollback re-enables an originally enabled inactive timer" "$INACTIVE_ROLLBACK_SYSTEMCTL_LOG" "--user enable wiki-fetch.timer"
assert_not_contains "rollback does not start an originally inactive timer" "$INACTIVE_ROLLBACK_SYSTEMCTL_LOG" "--user enable --now wiki-fetch.timer"

LOCKED_FIXTURE_ROOT="$TEST_ROOT/projection-locked-fixture"
LOCKED_REMOTE="$(make_projection_remote "$LOCKED_FIXTURE_ROOT")"
LOCKED_LIVE="$TEST_ROOT/projection-locked-live"
LOCKED_TARGET="$TEST_ROOT/projection-locked-git"
"$REAL_GIT" clone -q "$LOCKED_REMOTE" "$LOCKED_LIVE"
LOCKED_GIT_DIR="$($REAL_GIT -C "$LOCKED_LIVE" rev-parse --absolute-git-dir)"
mkdir -p "$LOCKED_GIT_DIR/vault-sync"
printf '{"pid":%s,"owner_hostname":"test","owner_token":"busy","command":"existing-operation"}\n' "$$" > "$LOCKED_GIT_DIR/vault-sync/managed-write.lock"
LOCKED_INSTALL_OUT="$TEST_ROOT/projection-locked-install.out"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
run_install "$LOCKED_INSTALL_OUT" \
  --role leaf \
  --vault-path "$LOCKED_LIVE" \
  --fetch-projection "$LOCKED_TARGET" \
  --execute
LOCKED_INSTALL_RC=$?
assert_exit "projection migration fails closed on a live managed-write lock" "$LOCKED_INSTALL_RC" 1
assert_contains "projection lock contention is explicit" "$LOCKED_INSTALL_OUT" "could not acquire live-vault managed-write lock for fetch projection migration"
if [ ! -e "$LOCKED_TARGET" ]; then
  printf "PASS: %s\n" "lock contention aborts before creating the projection"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "lock contention aborts before creating the projection"
  FAIL=$((FAIL + 1))
fi

MAC_LOCKED_PRESENT="$TEST_ROOT/projection-macos-locked.present"
MAC_LOCKED_LOG="$TEST_ROOT/projection-macos-locked.launchctl.log"
MAC_LOCKED_OUT="$TEST_ROOT/projection-macos-locked-install.out"
MAC_FETCH_PLIST="$TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-fetch.plist"
printf '%s\n' "com.karlchow.wiki-fetch" > "$MAC_LOCKED_PRESENT"
write_valid_launchd_plist "$MAC_FETCH_PLIST" "com.karlchow.wiki-fetch" "pre-migration fetch"
TEST_UNAME_S=Darwin \
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
TEST_LAUNCHCTL_PRESENT_FILE="$MAC_LOCKED_PRESENT" \
TEST_LAUNCHCTL_LOG="$MAC_LOCKED_LOG" \
run_install "$MAC_LOCKED_OUT" \
  --role leaf \
  --vault-path "$LOCKED_LIVE" \
  --fetch-projection "$LOCKED_TARGET" \
  --execute
MAC_LOCKED_RC=$?
assert_exit "macOS projection migration also fails closed on the live lock" "$MAC_LOCKED_RC" 1
assert_contains "macOS projection migration stops the old fetch agent before lock acquisition" "$MAC_LOCKED_LOG" "bootout gui/$UID/com.karlchow.wiki-fetch"
assert_contains "macOS lock failure restores the old fetch agent" "$MAC_LOCKED_LOG" "bootstrap gui/$UID $MAC_FETCH_PLIST"
assert_not_contains "macOS rollback preserves the prior launchd enable state" "$MAC_LOCKED_LOG" "enable gui/$UID/com.karlchow.wiki-fetch"

DETACHED_LIVE="$TEST_ROOT/projection-live-without-git"
DETACHED_TARGET="$TEST_ROOT/projection-existing-git"
mkdir -p "$DETACHED_LIVE"
"$REAL_GIT" clone -q "$PROJECTION_REMOTE" "$DETACHED_TARGET"
DETACHED_INSTALL_OUT="$TEST_ROOT/projection-existing-install.out"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
run_install "$DETACHED_INSTALL_OUT" \
  --role leaf \
  --vault-path "$DETACHED_LIVE" \
  --fetch-projection "$DETACHED_TARGET" \
  --execute
DETACHED_INSTALL_RC=$?
assert_exit "existing projection remains installable after live Git quarantine" "$DETACHED_INSTALL_RC" 0
assert_contains "existing detached projection is validated" "$DETACHED_INSTALL_OUT" "Validated fetch projection: $DETACHED_TARGET"

NON_GIT_TARGET="$TEST_ROOT/projection-non-git"
mkdir -p "$NON_GIT_TARGET"
printf '%s\n' 'preserve me' > "$NON_GIT_TARGET/sentinel.txt"
NON_GIT_INSTALL_OUT="$TEST_ROOT/projection-non-git-install.out"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
run_install "$NON_GIT_INSTALL_OUT" \
  --role leaf \
  --vault-path "$PROJECTION_LIVE" \
  --fetch-projection "$NON_GIT_TARGET" \
  --execute
NON_GIT_INSTALL_RC=$?
assert_exit "existing non-Git projection target is rejected" "$NON_GIT_INSTALL_RC" 1
assert_contains "non-Git projection rejection is explicit" "$NON_GIT_INSTALL_OUT" "fetch projection is not an independent Git clone"
assert_contains "non-Git projection target is not overwritten" "$NON_GIT_TARGET/sentinel.txt" "preserve me"

LEDGER_FIXTURE_ROOT="$TEST_ROOT/projection-ledger-fixture"
LEDGER_REMOTE="$(make_projection_remote "$LEDGER_FIXTURE_ROOT")"
LEDGER_LIVE="$TEST_ROOT/projection-ledger-live"
LEDGER_TARGET="$TEST_ROOT/projection-ledger-git"
"$REAL_GIT" clone -q "$LEDGER_REMOTE" "$LEDGER_LIVE"
"$REAL_GIT" -C "$LEDGER_LIVE" config user.name "Vault Sync Test"
"$REAL_GIT" -C "$LEDGER_LIVE" config user.email "vault-sync-test@example.invalid"
mkdir -p "$LEDGER_LIVE/meta/log-events/2026-09-15"
printf '%s\n' '{"event_id":"forbidden"}' > "$LEDGER_LIVE/meta/log-events/2026-09-15/forbidden.json"
"$REAL_GIT" -C "$LEDGER_LIVE" add meta/log-events/2026-09-15/forbidden.json
"$REAL_GIT" -C "$LEDGER_LIVE" commit -qm "add forbidden ledger path"
"$REAL_GIT" -C "$LEDGER_LIVE" push -q origin main
LEDGER_INSTALL_OUT="$TEST_ROOT/projection-ledger-install.out"
TEST_REAL_GIT=1 \
TEST_REAL_GIT_BIN="$REAL_GIT" \
run_install "$LEDGER_INSTALL_OUT" \
  --role leaf \
  --vault-path "$LEDGER_LIVE" \
  --fetch-projection "$LEDGER_TARGET" \
  --execute
LEDGER_INSTALL_RC=$?
assert_exit "projection bootstrap rejects a remote tree containing ledger paths" "$LEDGER_INSTALL_RC" 1
assert_contains "ledger projection rejection is explicit" "$LEDGER_INSTALL_OUT" "fetch projection contains forbidden meta/log-events paths"
if [ ! -e "$LEDGER_TARGET" ]; then
  printf "PASS: %s\n" "failed ledger validation leaves no final projection directory"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "failed ledger validation leaves no final projection directory"
  FAIL=$((FAIL + 1))
fi
assert_contains "failed ledger validation preserves prior fetch projection config" "$TEST_ROOT/home/.skillwiki/.env" "vault_sync.fetch_projection=$DETACHED_TARGET"

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

# --- Scenario 16a: rollback restores valid old plist on repeated failure ---
MAC16A_HOME="$TEST_ROOT/macos-16a-home"
mkdir -p "$MAC16A_HOME/Library/LaunchAgents"
write_valid_launchd_plist "$MAC16A_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist" "com.karlchow.wiki-push" "OLD_PUSH_BODY_16A"
write_valid_launchd_plist "$MAC16A_HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist" "com.karlchow.wiki-fetch" "OLD_FETCH_BODY_16A"
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
write_valid_launchd_plist "$MAC16B_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist" "com.karlchow.wiki-push" "OLD_PUSH_BODY_16B"
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

# --- Scenario 16c: invalid old plist is retained for diagnostics, never restored ---
MAC16C_OUT="$TEST_ROOT/macos-16c.out"
MAC16C_HOME="$TEST_ROOT/macos-16c-home"
mkdir -p "$MAC16C_HOME/Library/LaunchAgents"
printf 'OLD_INVALID_PUSH_BODY_16C\n' > "$MAC16C_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
write_valid_launchd_plist "$MAC16C_HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist" "com.karlchow.wiki-fetch" "OLD_FETCH_BODY_16C"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC16C_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_PRINT_RC=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
VS_LAUNCHD_PRESENT_POLL_MAX=2 \
bash "$INSTALL_SH" --role leaf --execute >"$MAC16C_OUT" 2>&1
MAC16C_RC=$?
MAC16C_PUSH="$MAC16C_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
assert_exit "16c: repeated bootstrap failure still fails install" "$MAC16C_RC" 1
assert_not_contains "16c: invalid old push plist is not restored" "$MAC16C_PUSH" "OLD_INVALID_PUSH_BODY_16C"
assert_contains "16c: validated candidate remains after failed rollback" "$MAC16C_PUSH" "<plist version=\"1.0\">"
assert_contains "16c: invalid rollback is explicit" "$MAC16C_OUT" "previous plist was invalid; not restoring rollback artifact"
MAC16C_INTEGRITY_FILE="$(find "$MAC16C_HOME/Library/Caches/vault-sync/install-rollback" -name previous-plist-integrity -type f -print -quit 2>/dev/null)"
if [ -n "$MAC16C_INTEGRITY_FILE" ] && grep -q '^invalid:' "$MAC16C_INTEGRITY_FILE"; then
  printf "PASS: %s\n" "16c: invalid rollback integrity evidence retained"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "16c: invalid rollback integrity evidence retained"
  FAIL=$((FAIL + 1))
fi

# --- Scenario 16d: failed rollback-artifact copy is never treated as restorable ---
MAC16D_OUT="$TEST_ROOT/macos-16d.out"
MAC16D_HOME="$TEST_ROOT/macos-16d-home"
mkdir -p "$MAC16D_HOME/Library/LaunchAgents"
write_valid_launchd_plist "$MAC16D_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist" "com.karlchow.wiki-push" "OLD_PUSH_BODY_16D"
write_valid_launchd_plist "$MAC16D_HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist" "com.karlchow.wiki-fetch" "OLD_FETCH_BODY_16D"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC16D_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_CP_FAIL_ROLLBACK=1 \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_PRINT_RC=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
VS_LAUNCHD_PRESENT_POLL_MAX=2 \
bash "$INSTALL_SH" --role leaf --execute >"$MAC16D_OUT" 2>&1
MAC16D_RC=$?
MAC16D_PUSH="$MAC16D_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
assert_exit "16d: failed rollback copy still fails install" "$MAC16D_RC" 1
assert_not_contains "16d: failed rollback copy is not restored" "$MAC16D_PUSH" "OLD_PUSH_BODY_16D"
assert_contains "16d: candidate remains after unavailable rollback" "$MAC16D_PUSH" "<plist version=\"1.0\">"
assert_contains "16d: unavailable rollback copy is explicit" "$MAC16D_OUT" "could not retain verified rollback artifact"
assert_contains "16d: unavailable rollback is refused" "$MAC16D_OUT" "rollback artifact was unavailable or unverified"
MAC16D_INTEGRITY_FILE="$(find "$MAC16D_HOME/Library/Caches/vault-sync/install-rollback" -name previous-plist-integrity -type f -print -quit 2>/dev/null)"
if [ -n "$MAC16D_INTEGRITY_FILE" ] && grep -q '^unavailable: failed to copy previous plist' "$MAC16D_INTEGRITY_FILE"; then
  printf "PASS: %s\n" "16d: unavailable rollback integrity evidence retained"
  PASS=$((PASS + 1))
else
  printf "FAIL: %s\n" "16d: unavailable rollback integrity evidence retained"
  FAIL=$((FAIL + 1))
fi

# --- Scenario 16e: failed rollback restore copy leaves the validated candidate in place ---
MAC16E_OUT="$TEST_ROOT/macos-16e.out"
MAC16E_HOME="$TEST_ROOT/macos-16e-home"
mkdir -p "$MAC16E_HOME/Library/LaunchAgents"
write_valid_launchd_plist "$MAC16E_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist" "com.karlchow.wiki-push" "OLD_PUSH_BODY_16E"
write_valid_launchd_plist "$MAC16E_HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist" "com.karlchow.wiki-fetch" "OLD_FETCH_BODY_16E"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC16E_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_CP_FAIL_RESTORE=1 \
TEST_LAUNCHCTL_FAIL_ALL_BOOTSTRAP=1 \
TEST_LAUNCHCTL_PRINT_RC=1 \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
VS_LAUNCHD_UNLOAD_DEADLINE_S=1 \
VS_LAUNCHD_PRESENT_POLL_MAX=2 \
bash "$INSTALL_SH" --role leaf --execute >"$MAC16E_OUT" 2>&1
MAC16E_RC=$?
MAC16E_PUSH="$MAC16E_HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
assert_exit "16e: failed rollback restore still fails install" "$MAC16E_RC" 1
assert_not_contains "16e: failed rollback restore does not replace candidate" "$MAC16E_PUSH" "OLD_PUSH_BODY_16E"
assert_contains "16e: candidate remains after failed restore" "$MAC16E_PUSH" "<plist version=\"1.0\">"
assert_contains "16e: failed rollback restore is explicit" "$MAC16E_OUT" "failed to restore rollback artifact"

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

# Full non-dry-run install must hard-fail if runtime manifest cannot be written
MAC_MANIFEST_FAIL_HOME="$TEST_ROOT/macos-manifest-fail-home"
mkdir -p "$MAC_MANIFEST_FAIL_HOME/Library/Application Support/vault-sync"
# Block writing runtime-manifest.json by making that path a directory
mkdir -p "$MAC_MANIFEST_FAIL_HOME/Library/Application Support/vault-sync/runtime-manifest.json"
MAC_MANIFEST_FAIL_OUT="$TEST_ROOT/macos-manifest-fail.out"
make_fake_bin "$TEST_ROOT/fake-bin"
fresh_launchctl_state
HOME="$MAC_MANIFEST_FAIL_HOME" \
USER=root \
PATH="$TEST_ROOT/fake-bin:$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
VS_HOSTNAME=pvelxc-test \
TEST_UNAME_S=Darwin \
TEST_LAUNCHCTL_PRESENT_FILE="$TEST_LAUNCHCTL_PRESENT_FILE" \
bash "$INSTALL_SH" --role leaf --execute >"$MAC_MANIFEST_FAIL_OUT" 2>&1
MAC_MANIFEST_FAIL_RC=$?
assert_exit "install fails when runtime manifest cannot be written" "$MAC_MANIFEST_FAIL_RC" 1
assert_contains "manifest failure is fatal" "$MAC_MANIFEST_FAIL_OUT" "runtime manifest write failed"
assert_not_contains "no success banner without manifest" "$MAC_MANIFEST_FAIL_OUT" "vault-sync installed successfully."

# --- Scenario 17: full install on a plutil-less host (Ubuntu CI) ---
# On hosts without plutil (Ubuntu GitHub Actions runners), launchd plist
# validation uses the awk fallback in scripts/lib/platform.sh. This scenario
# runs the entire install end to end, so the fallback must accept the plists
# rendered from the shipped templates or the install dies; on macOS (plutil
# present) the same scenario exercises the plutil path.
MAC17_OUT="$TEST_ROOT/macos-17-no-plutil.out"
TEST_UNAME_S=Darwin TEST_EXTRA_PATH="$NODE_DIR" run_install "$MAC17_OUT" --role leaf --execute
MAC17_RC=$?
assert_exit "17: plutil-less-host install succeeds end to end" "$MAC17_RC" 0
assert_contains "17: push plist rendered from shipped template" "$TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-push.plist" "com.karlchow.wiki-push"
assert_contains "17: fetch plist rendered from shipped template" "$TEST_ROOT/home/Library/LaunchAgents/com.karlchow.wiki-fetch.plist" "com.karlchow.wiki-fetch"
assert_contains "17: install reports success" "$MAC17_OUT" "vault-sync installed successfully."
assert_not_contains "17: no plist validation failure" "$MAC17_OUT" "launchd plist invalid for"

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
