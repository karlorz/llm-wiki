#!/bin/bash
# snapshot-health-live-adapter.test.sh
#
# Live systemctl adapter gates for status.sh (v0.10.15).
# Proves the shell implementation:
#   1. Requests case-sensitive systemd property names (not fixture snake_case)
#   2. Treats a completed oneshot with empty ActiveEnterTimestamp as success
#      when ExecMainExitTimestamp / InactiveEnterTimestamp are present
#   3. Works for both system and user scopes
#
# Run: bash packages/vault-sync/test/snapshot-health-live-adapter.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATUS_SH="$VAULT_SYNC_ROOT/skills/vault-sync-status/status.sh"
FAKE_SYSTEMCTL="$VAULT_SYNC_ROOT/test/fixtures/snapshot-health/fake-systemctl.sh"

PASS=0
FAIL=0

if [ ! -f "$STATUS_SH" ]; then
  echo "FATAL: status.sh not found at $STATUS_SH" >&2
  exit 1
fi
if [ ! -f "$FAKE_SYSTEMCTL" ]; then
  echo "FATAL: shared fake-systemctl not found at $FAKE_SYSTEMCTL" >&2
  exit 1
fi

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# Core live systemd property names the health path must request (case-sensitive).
CORE_LIVE_PROPS=(
  UnitFileState
  ActiveState
  NextElapseUSecRealtime
  Result
  ExecMainStatus
  ActiveEnterTimestamp
  InactiveEnterTimestamp
  ExecMainStartTimestamp
  ExecMainExitTimestamp
)

install_fake_systemctl() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  # Wrapper so PATH finds `systemctl` while env selects profile/log.
  cat >"$bin_dir/systemctl" <<EOF
#!/usr/bin/env bash
exec bash "$FAKE_SYSTEMCTL" "\$@"
EOF
  chmod +x "$bin_dir/systemctl"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label expected='$expected' actual='$actual'"
    FAIL=$((FAIL + 1))
  fi
}

# Run status.sh for a profile/scope into $1 (case dir under TEST_ROOT).
# Writes out.json and requests.log under that directory.
run_status() {
  local case_dir="$1" scope="$2" profile="$3"
  mkdir -p "$case_dir"
  local home bin_dir request_log
  home="$(mktemp -d "$case_dir/home.XXXXXX")"
  bin_dir="$home/bin"
  request_log="$case_dir/requests.log"
  : >"$request_log"
  install_fake_systemctl "$bin_dir"

  mkdir -p "$home/wiki"
  # status.sh calls platform_detect_os which overwrites VS_OS from uname, so
  # place the completion log under both Linux and macOS log roots.
  local log_linux="$home/.local/state/vault-sync/log"
  local log_macos="$home/Library/Logs"
  mkdir -p "$log_linux" "$log_macos"
  if [ "$profile" = "completed" ]; then
    cat >"$log_linux/wiki-snapshot.log" <<'LOG'
2026-07-25 11:32:10 === Wiki Snapshot: 20260725_113210 ===
2026-07-25 11:33:38 Push successful
2026-07-25T11:33:40Z SNAPSHOT_COMPLETE schema=v1 outcome=pushed result=success ts=2026-07-25T11:33:40Z head=aaa1bbbb2ccc3ddd4eee5fff6aaa7bbb8ccc9ddd0 origin=fff6eee5ddd4ccc3bbb2aaa1fff6eee5ddd4ccc3
LOG
    cp "$log_linux/wiki-snapshot.log" "$log_macos/wiki-snapshot.log"
  fi

  env -u WIKI_REMOTE -u VS_SNAPSHOT_HEALTH_FIXTURE \
    PATH="$bin_dir:$PATH" \
    HOME="$home" \
    WIKI_PATH="$home/wiki" \
    VS_ROLE=snapshotter \
    VS_OS=linux \
    VS_SERVICE_SCOPE="$scope" \
    VS_SNAPSHOT_HEALTH_NOW="2026-07-25T12:00:00Z" \
    VS_SNAPSHOT_CADENCE_MINUTES=30 \
    VS_SNAPSHOT_SERVICE_TIMEOUT_SECONDS=900 \
    FAKE_SYSTEMCTL_LOG="$request_log" \
    FAKE_SYSTEMCTL_PROFILE="$profile" \
    bash "$STATUS_SH" --read-only --json >"$case_dir/out.json" 2>/dev/null || true
}

# Parse all check id→status once per case (single python).
load_status_map() {
  local json_file="$1" map_file="$2"
  python3 -c "
import json
with open('$json_file') as fh:
    d = json.load(fh)
with open('$map_file', 'w') as out:
    for c in d.get('checks', []):
        out.write(c.get('id', '') + '\t' + c.get('status', '') + '\n')
" 2>/dev/null || true
}

check_status() {
  local map_file="$1" id="$2"
  awk -F'\t' -v id="$id" '$1 == id { print $2; exit }' "$map_file"
}

echo "=== snapshot-health live adapter (status.sh) ==="

# ── completed oneshot, system scope ──
COMP="$TEST_ROOT/system-completed"
run_status "$COMP" system completed
load_status_map "$COMP/out.json" "$COMP/map.tsv"
assert_eq "system/completed jobs_enabled" "pass" "$(check_status "$COMP/map.tsv" vault_sync_jobs_enabled)"
assert_eq "system/completed service_result" "pass" "$(check_status "$COMP/map.tsv" vault_sync_snapshot_service_result)"
assert_eq "system/completed last_push_age" "pass" "$(check_status "$COMP/map.tsv" vault_sync_last_push_age)"

if command grep -q 'REFUSED_SNAKE_CASE' "$COMP/requests.log" 2>/dev/null; then
  echo "FAIL: system/completed requested snake_case properties"
  FAIL=$((FAIL + 1))
  command grep 'REFUSED_SNAKE_CASE' "$COMP/requests.log" || true
else
  echo "PASS: system/completed no snake_case properties requested"
  PASS=$((PASS + 1))
fi

for prop in "${CORE_LIVE_PROPS[@]}"; do
  if command grep -E $'\t'"${prop}"'$' "$COMP/requests.log" >/dev/null 2>&1; then
    echo "PASS: system/completed requested $prop"
    PASS=$((PASS + 1))
  else
    echo "FAIL: system/completed missing live property request: $prop"
    echo "  requests were:"
    cat "$COMP/requests.log" || true
    FAIL=$((FAIL + 1))
  fi
done

if command grep -q $'^system\t' "$COMP/requests.log"; then
  echo "PASS: system/completed used system scope"
  PASS=$((PASS + 1))
else
  echo "FAIL: system/completed did not record system scope"
  FAIL=$((FAIL + 1))
fi

# ── completed oneshot, user scope ──
UCOMP="$TEST_ROOT/user-completed"
run_status "$UCOMP" user completed
load_status_map "$UCOMP/out.json" "$UCOMP/map.tsv"
assert_eq "user/completed service_result" "pass" "$(check_status "$UCOMP/map.tsv" vault_sync_snapshot_service_result)"
if command grep -q $'^user\t' "$UCOMP/requests.log"; then
  echo "PASS: user/completed used user scope"
  PASS=$((PASS + 1))
else
  echo "FAIL: user/completed did not record user scope"
  FAIL=$((FAIL + 1))
fi

# ── never-run: Result=success but no completion timestamps → warn ──
NEVER="$TEST_ROOT/never-run"
run_status "$NEVER" system never-run
load_status_map "$NEVER/out.json" "$NEVER/map.tsv"
assert_eq "never-run service_result" "warn" "$(check_status "$NEVER/map.tsv" vault_sync_snapshot_service_result)"

# ── running within timeout via ExecMainStartTimestamp only ──
RUN="$TEST_ROOT/running"
run_status "$RUN" system running
load_status_map "$RUN/out.json" "$RUN/map.tsv"
assert_eq "running service_result" "pass" "$(check_status "$RUN/map.tsv" vault_sync_snapshot_service_result)"

# ── unavailable properties → warn ──
UN="$TEST_ROOT/unavailable"
run_status "$UN" system unavailable
load_status_map "$UN/out.json" "$UN/map.tsv"
assert_eq "unavailable jobs_enabled" "warn" "$(check_status "$UN/map.tsv" vault_sync_jobs_enabled)"
assert_eq "unavailable service_result" "warn" "$(check_status "$UN/map.tsv" vault_sync_snapshot_service_result)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
