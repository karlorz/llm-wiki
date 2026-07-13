#!/bin/bash
# Regression tests for packages/vault-sync/skills/vault-sync-status/status.sh.
#
# Run: bash packages/vault-sync/test/vault-sync-status.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATUS_SH="$VAULT_SYNC_ROOT/skills/vault-sync-status/status.sh"
RUNTIME_MANIFEST_LIB="$VAULT_SYNC_ROOT/scripts/lib/runtime-manifest.sh"

PASS=0
FAIL=0

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

# shellcheck source=/dev/null
source "$RUNTIME_MANIFEST_LIB"

share_dir_for_home() {
  local home="$1"
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$home/Library/Application Support/vault-sync" ;;
    *) printf '%s\n' "$home/.local/share/vault-sync" ;;
  esac
}

share_bin_for_home() {
  local home="$1"
  printf '%s/bin\n' "$(share_dir_for_home "$home")"
}

rclone_config_for_home() {
  local home="$1"
  printf '%s\n' "$home/.config/rclone"
}

prepare_home() {
  local home="$1"
  local bin_dir share_dir
  share_dir="$(share_dir_for_home "$home")"
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

write_runtime_manifest_for_home() {
  local home="$1"
  local wrong_hash="${2:-}"
  local share_dir agents_dir
  share_dir="$(share_dir_for_home "$home")"
  agents_dir="$home/Library/LaunchAgents"
  mkdir -p "$share_dir" "$agents_dir"

  vault_sync_write_runtime_manifest \
    "$share_dir/runtime-manifest.json" \
    "$share_dir" \
    "$agents_dir" \
    "0.0.0-test" \
    "deadbeef" \
    "0.0.0-test" \
    "2026-01-01T00:00:00Z" \
    "leaf" \
    "test-host"

  if [ -n "$wrong_hash" ]; then
    python3 - "$share_dir/runtime-manifest.json" "$wrong_hash" <<'PY'
import json, sys
path, bad = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
files = data.get("files") or {}
if not files:
    files["bin/wiki-push.sh"] = bad
else:
    key = next(iter(files))
    files[key] = bad
data["files"] = files
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY
  fi
}

# Hermetic status launcher: always drops ambient WIKI_REMOTE so process-env
# precedence cannot leak into unconfigured/profile tests.
run_status_json() {
  env -u WIKI_REMOTE bash "$STATUS_SH" --read-only --json
}

status_json_for_home() {
  local home="$1"
  HOME="$home" run_status_json
}

prepare_rclone_stub() {
  local root="$1"
  mkdir -p "$root/bin"
  cat > "$root/bin/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$RCLONE_CALLS"
if [ "${2:-}" = "${RCLONE_OK_REMOTE:-}" ]; then
  exit 0
fi
exit 1
STUB
  cat > "$root/bin/timeout" <<'STUB'
#!/bin/bash
shift
exec "$@"
STUB
  chmod +x "$root/bin/rclone" "$root/bin/timeout"
}

check_detail() {
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
        print(check.get("detail", ""))
        break
PY
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

extract_check_statuses() {
  local json="$1"
  shift
  JSON_INPUT="$json" python3 - "$@" <<'PY'
import json, os, sys
wanted = set(sys.argv[1:])
data = json.loads(os.environ["JSON_INPUT"])
out = {}
for check in data.get("checks", []):
    cid = check.get("id")
    if cid in wanted:
        out[cid] = check.get("status", "")
for cid in sorted(wanted):
    print(f"{cid}={out.get(cid, 'missing')}")
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

assert_ne() {
  local label="$1" actual="$2" not_expected="$3"
  if [ "$actual" != "$not_expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected not '%s', got '%s'\n" "$label" "$not_expected" "$actual"
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

test_reachability_local_vault_on_clean_git_vault() {
  local home="$TEST_ROOT/home-reach-local"
  prepare_home "$home"
  prepare_vault_clean "$home"
  git -C "$home/wiki" init -q
  git -C "$home/wiki" config user.email "t@t"
  git -C "$home/wiki" config user.name "t"
  git -C "$home/wiki" add -A
  git -C "$home/wiki" commit -q -m init

  local json status
  json="$(HOME="$home" WIKI_PATH="$home/wiki" bash "$STATUS_SH" --read-only --json)"
  status="$(check_status "$json" "reachability_local_vault")"

  assert_eq "reachability local vault on clean git vault" "$status" "pass"
}

test_reachability_snapshotter_not_checked_by_default() {
  local home="$TEST_ROOT/home-reach-snap"
  prepare_home "$home"

  local json status
  json="$(status_json_for_home "$home")"
  status="$(check_status "$json" "reachability_snapshotter")"

  assert_eq "snapshotter reachability not_checked by default" "$status" "pass"
}

test_s3_reachability_skips_when_remote_is_unconfigured() {
  local home="$TEST_ROOT/home-s3-unconfigured"
  local stub="$TEST_ROOT/stub-s3-unconfigured"
  local calls="$TEST_ROOT/s3-unconfigured.calls"
  prepare_home "$home"
  prepare_rclone_stub "$stub"
  : > "$calls"

  local json status detail call_count
  json="$(HOME="$home" PATH="$stub/bin:$PATH" RCLONE_CALLS="$calls" RCLONE_OK_REMOTE="none:wiki" run_status_json)"
  status="$(check_status "$json" "reachability_s3")"
  detail="$(check_detail "$json" "reachability_s3")"
  call_count="$(wc -l < "$calls" | tr -d ' ')"

  assert_eq "unconfigured S3 status is non-degraded" "$status" "pass"
  assert_eq "unconfigured S3 does not invoke rclone" "$call_count" "0"
  if printf '%s' "$detail" | grep -q 'not configured.*skipped'; then
    printf "PASS: unconfigured S3 detail explains skipped probe\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: unconfigured S3 detail missing skipped explanation — %s\n" "$detail"
    FAIL=$((FAIL + 1))
  fi
}

test_s3_reachability_uses_snapshotter_profile() {
  local home="$TEST_ROOT/home-s3-profile"
  local stub="$TEST_ROOT/stub-s3-profile"
  local calls="$TEST_ROOT/s3-profile.calls"
  local profile="$TEST_ROOT/sg01-snapshotter.env"
  local marker="$TEST_ROOT/profile-must-not-execute"
  prepare_home "$home"
  prepare_rclone_stub "$stub"
  : > "$calls"
  cat > "$profile" <<EOF
UNRELATED=\$(touch "$marker")
CLOUD_REMOTE=cloud:cloud/wiki
EOF

  local json status detail first_call
  json="$(HOME="$home" PATH="$stub/bin:$PATH" VS_ROLE=snapshotter VS_SNAPSHOT_PROFILE="$profile" RCLONE_CALLS="$calls" RCLONE_OK_REMOTE="cloud:cloud/wiki" run_status_json)"
  status="$(check_status "$json" "reachability_s3")"
  detail="$(check_detail "$json" "reachability_s3")"
  first_call="$(head -n 1 "$calls" 2>/dev/null || true)"

  assert_eq "snapshotter profile S3 probe passes" "$status" "pass"
  if printf '%s' "$first_call" | grep -q '^lsf cloud:cloud/wiki '; then
    printf "PASS: snapshotter profile supplies exact CLOUD_REMOTE\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshotter profile remote not used — call='%s'\n" "$first_call"
    FAIL=$((FAIL + 1))
  fi
  if printf '%s' "$detail" | grep -q 'snapshotter profile'; then
    printf "PASS: snapshotter profile source appears in detail\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshotter profile source missing from detail — %s\n" "$detail"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -e "$marker" ]; then
    printf "PASS: snapshotter profile parsed without execution\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshotter profile content was executed\n"
    FAIL=$((FAIL + 1))
  fi
}

test_s3_reachability_uses_installed_snapshot_profile_path() {
  local home="$TEST_ROOT/home-s3-installed-profile"
  local stub="$TEST_ROOT/stub-s3-installed-profile"
  local calls="$TEST_ROOT/s3-installed-profile.calls"
  local profile="$TEST_ROOT/custom-installed-snapshotter.env"
  prepare_home "$home"
  prepare_rclone_stub "$stub"
  mkdir -p "$home/.skillwiki"
  printf 'vault_sync.role=snapshotter\nvault_sync.snapshot_profile=%s\n' "$profile" > "$home/.skillwiki/.env"
  printf 'CLOUD_REMOTE=installed-profile:wiki\n' > "$profile"
  : > "$calls"

  local json first_call detail
  # Clear process override without wrapping the shell function in `env` (env cannot exec functions).
  json="$(HOME="$home" PATH="$stub/bin:$PATH" RCLONE_CALLS="$calls" RCLONE_OK_REMOTE="installed-profile:wiki" VS_SNAPSHOT_PROFILE= run_status_json)"
  first_call="$(head -n 1 "$calls" 2>/dev/null || true)"
  detail="$(check_detail "$json" "reachability_s3")"

  assert_eq "installed snapshot_profile check passes" "$(check_status "$json" "reachability_s3")" "pass"
  if printf '%s' "$first_call" | grep -q '^lsf installed-profile:wiki '; then
    printf "PASS: vault_sync.snapshot_profile supplies CLOUD_REMOTE without VS_SNAPSHOT_PROFILE\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: installed snapshot_profile remote not used — call='%s'\n" "$first_call"
    FAIL=$((FAIL + 1))
  fi
  if printf '%s' "$detail" | grep -q 'snapshotter profile'; then
    printf "PASS: installed snapshot_profile source appears in detail\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: installed snapshot_profile source missing from detail — %s\n" "$detail"
    FAIL=$((FAIL + 1))
  fi
}

test_s3_reachability_env_file_overrides_snapshotter_profile() {
  local home="$TEST_ROOT/home-s3-env-file"
  local stub="$TEST_ROOT/stub-s3-env-file"
  local calls="$TEST_ROOT/s3-env-file.calls"
  local profile="$TEST_ROOT/sg01-env-file-snapshotter.env"
  prepare_home "$home"
  prepare_rclone_stub "$stub"
  mkdir -p "$home/.skillwiki"
  printf 'vault_sync.role=snapshotter\nWIKI_REMOTE=env-file:wiki\n' > "$home/.skillwiki/.env"
  printf 'CLOUD_REMOTE=profile:wiki\n' > "$profile"
  : > "$calls"

  local json first_call
  json="$(HOME="$home" PATH="$stub/bin:$PATH" VS_SNAPSHOT_PROFILE="$profile" RCLONE_CALLS="$calls" RCLONE_OK_REMOTE="env-file:wiki" run_status_json)"
  first_call="$(head -n 1 "$calls" 2>/dev/null || true)"

  assert_eq "env-file remote check passes" "$(check_status "$json" "reachability_s3")" "pass"
  if printf '%s' "$first_call" | grep -q '^lsf env-file:wiki '; then
    printf "PASS: env-file WIKI_REMOTE overrides snapshotter profile\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: env-file WIKI_REMOTE precedence wrong — call='%s'\n" "$first_call"
    FAIL=$((FAIL + 1))
  fi
}

test_s3_reachability_process_env_overrides_env_file() {
  local home="$TEST_ROOT/home-s3-process-env"
  local stub="$TEST_ROOT/stub-s3-process-env"
  local calls="$TEST_ROOT/s3-process-env.calls"
  prepare_home "$home"
  prepare_rclone_stub "$stub"
  mkdir -p "$home/.skillwiki"
  printf 'WIKI_REMOTE=env-file:wiki\n' > "$home/.skillwiki/.env"
  : > "$calls"

  local json first_call
  # Intentionally set process WIKI_REMOTE (overrides env -u in run_status_json via assignment).
  json="$(HOME="$home" PATH="$stub/bin:$PATH" WIKI_REMOTE="process:wiki" RCLONE_CALLS="$calls" RCLONE_OK_REMOTE="process:wiki" bash "$STATUS_SH" --read-only --json)"
  first_call="$(head -n 1 "$calls" 2>/dev/null || true)"

  assert_eq "process env remote check passes" "$(check_status "$json" "reachability_s3")" "pass"
  if printf '%s' "$first_call" | grep -q '^lsf process:wiki '; then
    printf "PASS: process WIKI_REMOTE overrides env file\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: process WIKI_REMOTE precedence wrong — call='%s'\n" "$first_call"
    FAIL=$((FAIL + 1))
  fi
}

test_s3_reachability_works_without_timeout_binary() {
  # Stock macOS often lacks GNU timeout. Missing timeout must not become a
  # false "S3 remote unreachable" when rclone itself succeeds.
  local home="$TEST_ROOT/home-s3-no-timeout"
  local stub="$TEST_ROOT/stub-s3-no-timeout"
  local calls="$TEST_ROOT/s3-no-timeout.calls"
  prepare_home "$home"
  mkdir -p "$stub/bin"
  cat > "$stub/bin/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$RCLONE_CALLS"
if [ "${2:-}" = "${RCLONE_OK_REMOTE:-}" ]; then
  exit 0
fi
exit 1
STUB
  # Intentionally no timeout/gtimeout stub — only rclone on PATH prefix.
  chmod +x "$stub/bin/rclone"
  mkdir -p "$home/.skillwiki"
  printf 'WIKI_REMOTE=cloud:cloud/wiki\n' > "$home/.skillwiki/.env"
  : > "$calls"

  # Build a PATH with only the stub bin + essential system dirs, excluding
  # any real timeout/gtimeout from the ambient environment.
  local clean_path="$stub/bin:/usr/bin:/bin"
  local json status detail call_count
  json="$(
    HOME="$home" \
    PATH="$clean_path" \
    RCLONE_CALLS="$calls" \
    RCLONE_OK_REMOTE="cloud:cloud/wiki" \
    env -u WIKI_REMOTE bash "$STATUS_SH" --read-only --json
  )"
  status="$(check_status "$json" "reachability_s3")"
  detail="$(check_detail "$json" "reachability_s3")"
  call_count="$(wc -l < "$calls" | tr -d ' ')"

  assert_eq "S3 pass without timeout binary" "$status" "pass"
  assert_eq "rclone invoked without timeout binary" "$call_count" "1"
  if printf '%s' "$detail" | grep -q 'rclone lsf cloud:cloud/wiki succeeded'; then
    printf "PASS: missing timeout does not report S3 unreachable\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: missing timeout S3 detail wrong — %s\n" "$detail"
    FAIL=$((FAIL + 1))
  fi
}

test_s3_reachability_warns_when_configured_remote_fails() {
  local home="$TEST_ROOT/home-s3-failure"
  local stub="$TEST_ROOT/stub-s3-failure"
  local calls="$TEST_ROOT/s3-failure.calls"
  prepare_home "$home"
  prepare_rclone_stub "$stub"
  mkdir -p "$home/.skillwiki"
  printf 'WIKI_REMOTE=configured:wiki\n' > "$home/.skillwiki/.env"
  : > "$calls"

  local json status detail first_call
  json="$(HOME="$home" PATH="$stub/bin:$PATH" RCLONE_CALLS="$calls" RCLONE_OK_REMOTE="different:wiki" run_status_json)"
  status="$(check_status "$json" "reachability_s3")"
  detail="$(check_detail "$json" "reachability_s3")"
  first_call="$(head -n 1 "$calls" 2>/dev/null || true)"

  assert_eq "configured failing S3 remote warns" "$status" "warn"
  if printf '%s' "$detail" | grep -q 'unreachable.*configured:wiki'; then
    printf "PASS: configured failing S3 detail identifies unreachable remote\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: configured failing S3 detail is incomplete — %s\n" "$detail"
    FAIL=$((FAIL + 1))
  fi
  if printf '%s' "$first_call" | grep -q '^lsf configured:wiki '; then
    printf "PASS: configured failing S3 probe uses exact remote\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: configured failing S3 probe used wrong remote — call='%s'\n" "$first_call"
    FAIL=$((FAIL + 1))
  fi
}

# --- Task 5: cwd independence + runtime proof ---

test_status_identical_from_arbitrary_cwd() {
  local home="$TEST_ROOT/home-cwd"
  prepare_home "$home"
  prepare_vault_clean "$home"
  git -C "$home/wiki" init -q
  git -C "$home/wiki" config user.email "t@t"
  git -C "$home/wiki" config user.name "t"
  git -C "$home/wiki" add -A
  git -C "$home/wiki" commit -q -m init

  local j1 j2 j3 s1 s2 s3
  local ids="reachability_github reachability_s3 reachability_local_vault vault_sync_conflict_markers"

  j1="$(cd "$home/wiki" && HOME="$home" WIKI_PATH="$home/wiki" bash "$STATUS_SH" --read-only --json)"
  j2="$(cd "$VAULT_SYNC_ROOT" && HOME="$home" WIKI_PATH="$home/wiki" bash "$STATUS_SH" --read-only --json)"
  j3="$(cd /tmp && HOME="$home" WIKI_PATH="$home/wiki" bash "$STATUS_SH" --read-only --json)"

  s1="$(extract_check_statuses "$j1" $ids)"
  s2="$(extract_check_statuses "$j2" $ids)"
  s3="$(extract_check_statuses "$j3" $ids)"

  if [ "$s1" = "$s2" ] && [ "$s2" = "$s3" ]; then
    printf "PASS: status identical from vault root / package root / /tmp\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: status not identical across cwds\n"
    printf "  vault root:\n%s\n" "$s1"
    printf "  package root:\n%s\n" "$s2"
    printf "  /tmp:\n%s\n" "$s3"
    FAIL=$((FAIL + 1))
  fi

  # Also ensure local vault check does not flip to missing when cwd is /tmp
  local local_status
  local_status="$(check_status "$j3" "reachability_local_vault")"
  assert_eq "local vault reachable from /tmp cwd" "$local_status" "pass"
}

test_status_warns_runtime_hash_mismatch() {
  local home="$TEST_ROOT/home-runtime-mismatch"
  prepare_home "$home"
  write_runtime_manifest_for_home "$home" "0000000000000000000000000000000000000000000000000000000000000000"

  local json status match_status manifest_status
  json="$(status_json_for_home "$home")"
  match_status="$(check_status "$json" "vault_sync_runtime_match")"
  manifest_status="$(check_status "$json" "vault_sync_runtime_manifest")"

  assert_eq "runtime manifest present when written" "$manifest_status" "pass"
  assert_ne "runtime match not pass on hash mismatch" "$match_status" "pass"
}

test_status_reports_runtime_match_when_hashes_equal() {
  local home="$TEST_ROOT/home-runtime-match"
  prepare_home "$home"
  write_runtime_manifest_for_home "$home"

  local json match_status manifest_status live_status
  json="$(status_json_for_home "$home")"
  match_status="$(check_status "$json" "vault_sync_runtime_match")"
  manifest_status="$(check_status "$json" "vault_sync_runtime_manifest")"
  live_status="$(check_status "$json" "vault_sync_live_verify")"

  assert_eq "runtime manifest parseable" "$manifest_status" "pass"
  assert_eq "runtime match when hashes equal package sources" "$match_status" "pass"
  assert_eq "live verify pending without marker" "$live_status" "warn"

  # Mark live verified and re-check
  mkdir -p "$(share_dir_for_home "$home")"
  : > "$(share_dir_for_home "$home")/live-verify.ok"
  json="$(status_json_for_home "$home")"
  live_status="$(check_status "$json" "vault_sync_live_verify")"
  assert_eq "live verify pass with marker" "$live_status" "pass"
}

test_status_runtime_registration_warns_when_jobs_enabled_and_mismatch() {
  local home="$TEST_ROOT/home-runtime-reg"
  prepare_home "$home"
  write_runtime_manifest_for_home "$home" "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

  # Seed launchd unit files so read-only jobs_enabled is pass on macOS
  mkdir -p "$home/Library/LaunchAgents"
  : > "$home/Library/LaunchAgents/com.karlchow.wiki-push.plist"
  : > "$home/Library/LaunchAgents/com.karlchow.wiki-fetch.plist"
  # Linux: seed systemd timers
  mkdir -p "$home/.config/systemd/user"
  : > "$home/.config/systemd/user/wiki-push.timer"
  : > "$home/.config/systemd/user/wiki-fetch.timer"

  local json reg_status match_status jobs_status
  json="$(status_json_for_home "$home")"
  match_status="$(check_status "$json" "vault_sync_runtime_match")"
  reg_status="$(check_status "$json" "vault_sync_runtime_registration")"
  jobs_status="$(check_status "$json" "vault_sync_jobs_enabled")"

  assert_ne "runtime match fails for registration scenario" "$match_status" "pass"
  assert_eq "jobs enabled in registration scenario" "$jobs_status" "pass"
  assert_eq "registration warns when jobs enabled + runtime mismatch" "$reg_status" "warn"
}

test_s3_reachability_bounds_hanging_rclone_without_gnu_timeout() {
  # Without GNU timeout/gtimeout, hard fallback (python3/bash) must still bound
  # a hanging rclone so status does not block for tens of seconds.
  local home="$TEST_ROOT/home-s3-hang"
  local stub="$TEST_ROOT/stub-s3-hang"
  local calls="$TEST_ROOT/s3-hang.calls"
  prepare_home "$home"
  mkdir -p "$home/.skillwiki" "$stub/bin"
  printf 'WIKI_REMOTE=hanging:wiki\n' >"$home/.skillwiki/.env"
  : >"$calls"
  cat >"$stub/bin/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "${RCLONE_CALLS:-/dev/null}"
sleep 30
exit 0
STUB
  chmod +x "$stub/bin/rclone"
  # PATH: stub rclone only + bare system bins; no timeout/gtimeout.
  local start end elapsed status json
  start="$(date +%s)"
  json="$(
    env -u WIKI_REMOTE \
      HOME="$home" \
      RCLONE_CALLS="$calls" \
      VS_REACHABILITY_TIMEOUT=1 \
      PATH="$stub/bin:/usr/bin:/bin" \
      bash "$STATUS_SH" --read-only --json 2>/dev/null
  )"
  end="$(date +%s)"
  elapsed=$((end - start))
  status="$(check_status "$json" "reachability_s3")"
  # Timed-out rclone is not success; warn is correct for unreachable/failed probe.
  assert_eq "hanging rclone without GNU timeout is not pass" "$status" "warn"
  if [ "$elapsed" -lt 15 ]; then
    printf "PASS: %s\n" "hanging rclone bounded under 15s (elapsed=${elapsed}s)"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s\n" "hanging rclone bounded under 15s (elapsed=${elapsed}s)"
    FAIL=$((FAIL + 1))
  fi
}

test_status_reports_installed_scripts_in_sync
test_status_warns_when_installed_script_differs_from_source
test_conflict_markers_pass_on_clean_vault
test_conflict_markers_error_on_conflict_block
test_conflict_markers_pass_on_standalone_separator

test_reachability_local_vault_on_clean_git_vault
test_reachability_snapshotter_not_checked_by_default
test_s3_reachability_skips_when_remote_is_unconfigured
test_s3_reachability_uses_snapshotter_profile
test_s3_reachability_uses_installed_snapshot_profile_path
test_s3_reachability_env_file_overrides_snapshotter_profile
test_s3_reachability_process_env_overrides_env_file
test_s3_reachability_works_without_timeout_binary
test_s3_reachability_bounds_hanging_rclone_without_gnu_timeout
test_s3_reachability_warns_when_configured_remote_fails

test_status_identical_from_arbitrary_cwd
test_status_warns_runtime_hash_mismatch
test_status_reports_runtime_match_when_hashes_equal
test_status_runtime_registration_warns_when_jobs_enabled_and_mismatch

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
