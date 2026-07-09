#!/bin/bash
# Regression tests for packages/vault-sync/skills/vault-sync-status/status.sh.
#
# Run: bash packages/vault-sync/test/vault-sync-status.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATUS_SH="$VAULT_SYNC_ROOT/skills/vault-sync-status/status.sh"

PASS=0
FAIL=0

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

share_bin_for_home() {
  local home="$1"
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$home/Library/Application Support/vault-sync/bin" ;;
    *) printf '%s\n' "$home/.local/share/vault-sync/bin" ;;
  esac
}

rclone_config_for_home() {
  local home="$1"
  printf '%s\n' "$home/.config/rclone"
}

prepare_home() {
  local home="$1"
  local bin_dir
  bin_dir="$(share_bin_for_home "$home")"
  mkdir -p "$bin_dir" "$bin_dir/lib" "$(rclone_config_for_home "$home")"

  cp "$VAULT_SYNC_ROOT/scripts/"*.sh "$bin_dir/"
  cp "$VAULT_SYNC_ROOT/scripts/lib/"*.sh "$bin_dir/lib/"
  cp "$VAULT_SYNC_ROOT/skills/vault-presync/wiki-sync.sh" "$bin_dir/wiki-sync.sh"
  chmod +x "$bin_dir/"*.sh "$bin_dir/lib/"*.sh

  cat > "$(rclone_config_for_home "$home")/wiki-push-filters.txt" <<'FILTERS'
- remotely-save/data.json
- .skillwiki/sync.lock
- .skillwiki/memory/**
- .skillwiki/memory-topics.json
- .claude/settings.local.json
FILTERS
}

status_json_for_home() {
  local home="$1"
  HOME="$home" bash "$STATUS_SH" --read-only --json
}

check_status() {
  local json="$1"
  local check_id="$2"
  JSON_INPUT="$json" python3 - "$check_id" <<'PY'
import json
import os
import sys

data = json.loads(os.environ["JSON_INPUT"])
check_id = sys.argv[1]
for check in data.get("checks", []):
    if check.get("id") == check_id:
        print(check.get("status", ""))
        break
else:
    print("missing")
PY
}

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

test_status_reports_installed_scripts_in_sync() {
  local home="$TEST_ROOT/home-sync"
  prepare_home "$home"

  local json status
  json="$(status_json_for_home "$home")"
  status="$(check_status "$json" "vault_sync_script_drift")"

  assert_eq "status reports installed scripts in sync" "$status" "pass"
}

test_status_warns_when_installed_script_differs_from_source() {
  local home="$TEST_ROOT/home-drift"
  prepare_home "$home"
  local bin_dir
  bin_dir="$(share_bin_for_home "$home")"
  printf '\n# stale local edit\n' >> "$bin_dir/wiki-pull-with-auto-resolve.sh"

  local json status
  json="$(status_json_for_home "$home")"
  status="$(check_status "$json" "vault_sync_script_drift")"

  assert_eq "status warns when installed script differs from source" "$status" "warn"
}

conflict_block_md() {
  cat <<'EOF'
## Overview

<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch

## Related
EOF
}

prepare_vault_clean() {
  local home="$1"
  mkdir -p "$home/wiki/concepts"
  printf '# Clean\n\nNo conflicts here.\n' > "$home/wiki/concepts/clean.md"
}

prepare_vault_conflict() {
  local home="$1"
  mkdir -p "$home/wiki/concepts"
  conflict_block_md > "$home/wiki/concepts/conflicted.md"
}

prepare_vault_separator_only() {
  local home="$1"
  mkdir -p "$home/wiki/concepts"
  printf '## Overview\n\n=======\n\nNot a conflict.\n' > "$home/wiki/concepts/separator.md"
}

test_conflict_markers_pass_on_clean_vault() {
  local home="$TEST_ROOT/home-conflict-clean"
  prepare_home "$home"
  prepare_vault_clean "$home"

  local json status
  json="$(status_json_for_home "$home")"
  status="$(check_status "$json" "vault_sync_conflict_markers")"

  assert_eq "conflict markers pass on clean vault" "$status" "pass"
}

test_conflict_markers_error_on_conflict_block() {
  local home="$TEST_ROOT/home-conflict-block"
  prepare_home "$home"
  prepare_vault_conflict "$home"

  local json status detail
  json="$(status_json_for_home "$home")"
  status="$(check_status "$json" "vault_sync_conflict_markers")"
  detail="$(JSON_INPUT="$json" python3 - <<'PY'
import json, os
data = json.loads(os.environ["JSON_INPUT"])
for check in data.get("checks", []):
    if check.get("id") == "vault_sync_conflict_markers":
        print(check.get("detail", ""))
        break
PY
)"

  if [ "$status" = "error" ] && printf '%s' "$detail" | grep -q 'concepts/conflicted.md'; then
    printf "PASS: conflict markers error on conflict block with path detail\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: conflict markers error on conflict block — status='%s' detail='%s'\n" "$status" "$detail"
    FAIL=$((FAIL + 1))
  fi
}

test_conflict_markers_pass_on_standalone_separator() {
  local home="$TEST_ROOT/home-conflict-sep"
  prepare_home "$home"
  prepare_vault_separator_only "$home"

  local json status
  json="$(status_json_for_home "$home")"
  status="$(check_status "$json" "vault_sync_conflict_markers")"

  assert_eq "conflict markers pass on standalone separator" "$status" "pass"
}

test_status_reports_installed_scripts_in_sync
test_status_warns_when_installed_script_differs_from_source
test_conflict_markers_pass_on_clean_vault
test_conflict_markers_error_on_conflict_block
test_conflict_markers_pass_on_standalone_separator

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
