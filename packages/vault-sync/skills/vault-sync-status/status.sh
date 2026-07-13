#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PLATFORM_LIB="$VAULT_SYNC_ROOT/scripts/lib/platform.sh"
if [ ! -f "$PLATFORM_LIB" ]; then
  echo "FATAL: missing platform helper: $PLATFORM_LIB" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$PLATFORM_LIB"

CONFLICT_MARKERS_LIB="$VAULT_SYNC_ROOT/scripts/lib/conflict-markers.sh"
if [ ! -f "$CONFLICT_MARKERS_LIB" ]; then
  echo "FATAL: missing conflict-markers helper: $CONFLICT_MARKERS_LIB" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFLICT_MARKERS_LIB"

RUNTIME_MANIFEST_LIB="$VAULT_SYNC_ROOT/scripts/lib/runtime-manifest.sh"
if [ ! -f "$RUNTIME_MANIFEST_LIB" ]; then
  echo "FATAL: missing runtime-manifest helper: $RUNTIME_MANIFEST_LIB" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$RUNTIME_MANIFEST_LIB"

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_true() {
  case "$(lower "${1:-}")" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

log() {
  printf '[vault-sync-status] %s\n' "$*"
}

fatal() {
  printf '[vault-sync-status] FATAL: %s\n' "$*" >&2
  exit 1
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

# Portable short-timeout wrapper for network reachability probes.
# Prefer GNU timeout, then Homebrew gtimeout, then a hard fallback so probes
# never hang indefinitely (fleet hosts without coreutils timeout).
# Returns 124 on timeout (GNU convention) when the hard fallback fires.
with_timeout() {
  local secs="$1"
  shift
  if [ -z "${secs:-}" ] || ! printf '%s' "$secs" | grep -Eq '^[1-9][0-9]*$'; then
    secs=3
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi
  # Hard fallback: python3 subprocess timeout (widely available on fleet hosts).
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$secs" "$@" <<'PY'
import subprocess, sys
secs = int(sys.argv[1])
cmd = sys.argv[2:]
try:
    r = subprocess.run(cmd, timeout=secs)
    sys.exit(r.returncode)
except subprocess.TimeoutExpired:
    sys.exit(124)
except OSError:
    sys.exit(127)
PY
    return $?
  fi
  # Bash background + kill (Bash 3.2-safe; no mapfile/associative arrays).
  "$@" &
  local pid=$!
  local i=0
  while [ "$i" -lt "$secs" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 124
  fi
  wait "$pid"
  return $?
}

# Optional override for reachability probe bound (positive integer seconds).
reachability_timeout_secs() {
  local secs="${VS_REACHABILITY_TIMEOUT:-3}"
  if printf '%s' "$secs" | grep -Eq '^[1-9][0-9]*$'; then
    printf '%s\n' "$secs"
  else
    printf '3\n'
  fi
}

declare -a CHECK_IDS=()
declare -a CHECK_LABELS=()
declare -a CHECK_STATUS=()
declare -a CHECK_DETAIL=()

add_check() {
  CHECK_IDS+=("$1")
  CHECK_LABELS+=("$2")
  CHECK_STATUS+=("$3")
  CHECK_DETAIL+=("$4")
}

lookup_check_status() {
  local want="$1"
  local idx=0
  local total="${#CHECK_IDS[@]}"
  while [ "$idx" -lt "$total" ]; do
    if [ "${CHECK_IDS[$idx]}" = "$want" ]; then
      printf '%s\n' "${CHECK_STATUS[$idx]}"
      return 0
    fi
    idx=$((idx + 1))
  done
  printf 'missing\n'
}

file_value() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 1
  fi
  awk -F= -v k="$key" '$1==k {print substr($0, index($0,"=")+1); exit}' "$file"
}

config_value() {
  file_value "$HOME/.skillwiki/.env" "$1"
}

resolve_s3_remote() {
  S3_REMOTE=""
  S3_REMOTE_SOURCE=""

  if [ -n "${WIKI_REMOTE:-}" ]; then
    S3_REMOTE="$WIKI_REMOTE"
    S3_REMOTE_SOURCE="process environment"
    return 0
  fi

  local configured=""
  if configured=$(config_value "WIKI_REMOTE"); then
    if [ -n "$configured" ]; then
      S3_REMOTE="$configured"
      S3_REMOTE_SOURCE="SkillWiki env file"
      return 0
    fi
  fi

  if [ "${ROLE:-}" = "snapshotter" ]; then
    # Prefer process override, then installed path resolved once at startup, then hostname default.
    local profile="${VS_SNAPSHOT_PROFILE:-${SNAPSHOT_PROFILE:-/etc/vault-sync/profiles/$(hostname)-snapshotter.env}}"
    local profile_remote=""
    if profile_remote=$(file_value "$profile" "WIKI_REMOTE"); then
      if [ -n "$profile_remote" ]; then
        S3_REMOTE="$profile_remote"
        S3_REMOTE_SOURCE="snapshotter profile"
        return 0
      fi
    fi
    if profile_remote=$(file_value "$profile" "CLOUD_REMOTE"); then
      if [ -n "$profile_remote" ]; then
        S3_REMOTE="$profile_remote"
        S3_REMOTE_SOURCE="snapshotter profile"
        return 0
      fi
    fi
  fi

  return 1
}

# Resolve vault path once. Priority: VS_VAULT_PATH, WIKI_PATH, skillwiki, $HOME/wiki.
# Always returns an absolute path when possible.
resolve_vault_path() {
  local candidate=""
  if [ -n "${VS_VAULT_PATH:-}" ]; then
    candidate="$VS_VAULT_PATH"
  elif [ -n "${WIKI_PATH:-}" ]; then
    candidate="$WIKI_PATH"
  elif command -v skillwiki >/dev/null 2>&1; then
    candidate="$(skillwiki --human path 2>/dev/null | sed 's/ (via.*//' | head -1 || true)"
    candidate="$(printf '%s' "$candidate" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # skillwiki may print error text when no vault is configured — ignore non-paths.
    case "$candidate" in
      /*) ;;
      *) candidate="" ;;
    esac
  fi
  if [ -z "$candidate" ]; then
    candidate="${HOME}/wiki"
  fi
  case "$candidate" in
    /*) printf '%s\n' "$candidate" ;;
    *)
      if [ -d "$candidate" ]; then
        (cd "$candidate" 2>/dev/null && pwd) || printf '%s\n' "$candidate"
      else
        # Relative path that does not exist yet — make absolute via $PWD.
        printf '%s/%s\n' "$(pwd -P 2>/dev/null || pwd)" "$candidate" | sed 's#//#/#g'
      fi
      ;;
  esac
}

assert_read_only_allows_no_state_changes() {
  local action="$1"
  if [ "$READ_ONLY" -eq 1 ]; then
    printf '[vault-sync-status] ERROR: --read-only refuses state-changing action: %s\n' "$action" >&2
    return 73
  fi
  return 0
}

classify_log_tail() {
  local file="$1"
  local check_id="$2"
  local label="$3"
  local ok_regex="$4"

  if [ ! -f "$file" ]; then
    add_check "$check_id" "$label" "warn" "log file missing: $file"
    return 0
  fi

  local tail_lines last
  tail_lines=$(tail -n 20 "$file")
  last=$(printf '%s
' "$tail_lines" | grep -E "FAIL|ERROR|$ok_regex" | tail -n 1 || true)
  if [ -z "$last" ]; then
    last=$(printf '%s
' "$tail_lines" | tail -n 1)
  fi
  if [ -z "$last" ]; then
    add_check "$check_id" "$label" "warn" "log file empty: $file"
    return 0
  fi

  if printf '%s' "$last" | grep -Eq 'FAIL|ERROR'; then
    add_check "$check_id" "$label" "error" "$last"
  elif printf '%s' "$last" | grep -Eq "$ok_regex"; then
    add_check "$check_id" "$label" "pass" "$last"
  else
    add_check "$check_id" "$label" "warn" "$last"
  fi
}

script_drift_status="pass"
script_drift_detail=""
script_drift_compared=0

record_script_drift() {
  local detail="$1"
  script_drift_status="warn"
  if [ -n "$script_drift_detail" ]; then
    script_drift_detail="$script_drift_detail; $detail"
  else
    script_drift_detail="$detail"
  fi
}

compare_installed_file() {
  local src="$1"
  local dst="$2"
  local label="$3"

  [ -f "$src" ] || return 0
  script_drift_compared=$((script_drift_compared + 1))

  if [ ! -f "$dst" ]; then
    record_script_drift "missing live copy for $label: $dst"
  elif ! cmp -s "$src" "$dst"; then
    record_script_drift "live copy differs for $label: $dst"
  fi
}

check_installed_script_drift() {
  local src

  for src in "$VAULT_SYNC_ROOT/scripts/"*.sh; do
    [ -f "$src" ] || continue
    compare_installed_file "$src" "$SHARE_BIN/$(basename "$src")" "$(basename "$src")"
  done

  for src in "$VAULT_SYNC_ROOT/scripts/lib/"*.sh; do
    [ -f "$src" ] || continue
    compare_installed_file "$src" "$SHARE_BIN/lib/$(basename "$src")" "lib/$(basename "$src")"
  done

  compare_installed_file \
    "$VAULT_SYNC_ROOT/skills/vault-presync/wiki-sync.sh" \
    "$SHARE_BIN/wiki-sync.sh" \
    "wiki-sync.sh"

  if [ "$script_drift_compared" -eq 0 ]; then
    add_check "vault_sync_script_drift" "Vault sync script drift" "warn" "No package script sources found under $VAULT_SYNC_ROOT"
  elif [ "$script_drift_status" = "pass" ]; then
    add_check "vault_sync_script_drift" "Vault sync script drift" "pass" "$script_drift_compared installed script files match package source"
  else
    add_check "vault_sync_script_drift" "Vault sync script drift" "$script_drift_status" "$script_drift_detail"
  fi
}

# Compare runtime-manifest file hashes to package sources under VAULT_SYNC_ROOT.
# Sets RUNTIME_MATCH_STATUS / RUNTIME_MATCH_DETAIL for later registration check.
RUNTIME_MATCH_STATUS="warn"
RUNTIME_MATCH_DETAIL=""

check_runtime_proof() {
  local share_dir manifest_path live_marker
  share_dir="$(platform_share_dir)"
  manifest_path="$share_dir/runtime-manifest.json"
  live_marker="$share_dir/live-verify.ok"

  # vault_sync_runtime_manifest — present + parseable
  if [ ! -f "$manifest_path" ]; then
    add_check "vault_sync_runtime_manifest" "Vault sync runtime manifest" "warn" "Missing runtime manifest: $manifest_path"
    RUNTIME_MATCH_STATUS="warn"
    RUNTIME_MATCH_DETAIL="runtime manifest missing"
    add_check "vault_sync_runtime_match" "Vault sync runtime hash match" "warn" "$RUNTIME_MATCH_DETAIL"
  else
    local compared mismatches detail_bits
    compared=0
    mismatches=0
    detail_bits=""

    if ! command -v python3 >/dev/null 2>&1; then
      add_check "vault_sync_runtime_manifest" "Vault sync runtime manifest" "warn" "python3 required to parse $manifest_path"
      RUNTIME_MATCH_STATUS="warn"
      RUNTIME_MATCH_DETAIL="cannot parse runtime manifest without python3"
      add_check "vault_sync_runtime_match" "Vault sync runtime hash match" "warn" "$RUNTIME_MATCH_DETAIL"
    else
      # Parse + compare in one python pass for reliability.
      local py_out
      py_out="$(
        MANIFEST_PATH="$manifest_path" VAULT_SYNC_ROOT="$VAULT_SYNC_ROOT" python3 <<'PY'
import hashlib
import json
import os
import sys

manifest_path = os.environ["MANIFEST_PATH"]
root = os.environ["VAULT_SYNC_ROOT"]

def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def package_source(rel: str) -> str:
    if rel.startswith("bin/lib/"):
        return os.path.join(root, "scripts", "lib", rel[len("bin/lib/"):])
    if rel == "bin/wiki-sync.sh":
        return os.path.join(root, "skills", "vault-presync", "wiki-sync.sh")
    if rel.startswith("bin/"):
        return os.path.join(root, "scripts", rel[len("bin/"):])
    return ""

try:
    with open(manifest_path, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:  # noqa: BLE001 — surface parse errors to shell
    print(f"PARSE_ERROR\t{exc}")
    sys.exit(0)

if not isinstance(data, dict):
    print("PARSE_ERROR\tmanifest root is not an object")
    sys.exit(0)

files = data.get("files")
if not isinstance(files, dict):
    print("PARSE_ERROR\tfiles map missing or invalid")
    sys.exit(0)

print("PARSE_OK")
compared = 0
mismatches = []
skipped = 0
for rel, expected in sorted(files.items()):
    src = package_source(rel)
    if not src or not os.path.isfile(src):
        skipped += 1
        continue
    compared += 1
    actual = sha256(src)
    if actual != expected:
        mismatches.append(f"{rel}: expected {expected[:12]}… got {actual[:12]}…")

print(f"COMPARED\t{compared}")
print(f"SKIPPED\t{skipped}")
print(f"MISMATCH\t{len(mismatches)}")
for m in mismatches[:5]:
    print(f"DETAIL\t{m}")
PY
      )" || true

      if printf '%s\n' "$py_out" | grep -q '^PARSE_ERROR'; then
        local parse_err
        parse_err="$(printf '%s\n' "$py_out" | sed -n 's/^PARSE_ERROR\t//p' | head -1)"
        add_check "vault_sync_runtime_manifest" "Vault sync runtime manifest" "error" "Unparseable runtime manifest: ${parse_err:-$manifest_path}"
        RUNTIME_MATCH_STATUS="error"
        RUNTIME_MATCH_DETAIL="runtime manifest unparseable"
        add_check "vault_sync_runtime_match" "Vault sync runtime hash match" "error" "$RUNTIME_MATCH_DETAIL"
      else
        add_check "vault_sync_runtime_manifest" "Vault sync runtime manifest" "pass" "Present and parseable: $manifest_path"
        compared="$(printf '%s\n' "$py_out" | sed -n 's/^COMPARED\t//p' | head -1)"
        mismatches="$(printf '%s\n' "$py_out" | sed -n 's/^MISMATCH\t//p' | head -1)"
        compared="${compared:-0}"
        mismatches="${mismatches:-0}"
        if [ "$compared" -eq 0 ]; then
          RUNTIME_MATCH_STATUS="warn"
          RUNTIME_MATCH_DETAIL="runtime manifest has no comparable package-source file hashes"
          add_check "vault_sync_runtime_match" "Vault sync runtime hash match" "warn" "$RUNTIME_MATCH_DETAIL"
        elif [ "$mismatches" -gt 0 ]; then
          detail_bits="$(printf '%s\n' "$py_out" | sed -n 's/^DETAIL\t//p' | paste -sd '; ' -)"
          RUNTIME_MATCH_STATUS="warn"
          RUNTIME_MATCH_DETAIL="${mismatches} hash mismatch(es) vs package sources: ${detail_bits}"
          add_check "vault_sync_runtime_match" "Vault sync runtime hash match" "warn" "$RUNTIME_MATCH_DETAIL"
        else
          RUNTIME_MATCH_STATUS="pass"
          RUNTIME_MATCH_DETAIL="${compared} package-source file hash(es) match runtime manifest"
          add_check "vault_sync_runtime_match" "Vault sync runtime hash match" "pass" "$RUNTIME_MATCH_DETAIL"
        fi
      fi
    fi
  fi

  # vault_sync_runtime_registration — warn if jobs enabled but runtime mismatch
  local jobs_status
  jobs_status="$(lookup_check_status "vault_sync_jobs_enabled")"
  if [ "$jobs_status" = "pass" ] && [ "$RUNTIME_MATCH_STATUS" != "pass" ]; then
    add_check "vault_sync_runtime_registration" "Vault sync runtime registration proof" "warn" \
      "Jobs enabled but runtime hashes do not match package sources ($RUNTIME_MATCH_DETAIL)"
  elif [ "$RUNTIME_MATCH_STATUS" = "pass" ]; then
    add_check "vault_sync_runtime_registration" "Vault sync runtime registration proof" "pass" \
      "Runtime hashes match package sources"
  else
    add_check "vault_sync_runtime_registration" "Vault sync runtime registration proof" "warn" \
      "Runtime proof incomplete ($RUNTIME_MATCH_DETAIL); jobs_enabled=$jobs_status"
  fi

  # vault_sync_live_verify — pending warn until attended marker exists
  if [ -f "$live_marker" ]; then
    add_check "vault_sync_live_verify" "Vault sync live verify" "pass" "Live-verify marker present: $live_marker"
  else
    add_check "vault_sync_live_verify" "Vault sync live verify" "warn" "Pending live verify (marker missing: $live_marker)"
  fi
}

restart_jobs() {
  assert_read_only_allows_no_state_changes "restart-jobs" || return $?

  if [ "${ROLE:-}" = "snapshotter" ]; then
    if [ "$VS_OS" != "linux" ]; then
      fatal "snapshotter jobs require Linux"
    fi
    if [ "${SERVICE_SCOPE:-user}" = "system" ]; then
      systemctl restart wiki-snapshot.timer
    else
      systemctl --user restart wiki-snapshot.timer
    fi
    log "snapshot job restarted"
    return 0
  fi

  if [ "$VS_OS" = "macos" ]; then
    launchctl kickstart -k "gui/$UID/com.karlchow.wiki-push"
    launchctl kickstart -k "gui/$UID/com.karlchow.wiki-fetch"
  else
    systemctl --user restart wiki-push.timer wiki-fetch.timer
  fi
  log "jobs restarted"
}

READ_ONLY=0
JSON_OUT=0
RESTART_JOBS=0

if is_true "${VS_READ_ONLY:-0}"; then
  READ_ONLY=1
fi
if is_true "${VS_JSON:-0}"; then
  JSON_OUT=1
fi
if is_true "${VS_RESTART_JOBS:-0}"; then
  RESTART_JOBS=1
fi

usage() {
  cat <<USAGE
Usage: bash status.sh [options]

Options:
  --read-only      Read-only safety mode (no state-changing operations)
  --json           Emit JSON output (doctor-like shape)
  --restart-jobs   Restart scheduler jobs (refused under --read-only)
  --help           Show this help

Environment overrides:
  VS_READ_ONLY=1|0
  VS_JSON=1|0
  VS_RESTART_JOBS=1|0
  VS_VAULT_PATH=<path>
  WIKI_PATH=<path>
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --read-only)
      READ_ONLY=1
      shift
      ;;
    --json)
      JSON_OUT=1
      shift
      ;;
    --restart-jobs)
      RESTART_JOBS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fatal "unknown argument: $1"
      ;;
  esac
done

platform_detect_os
[ "$VS_OS" != "unsupported" ] || fatal "unsupported OS: $(uname -s)"

SHARE_BIN="$(platform_share_dir)/bin"
LOG_DIR="$(platform_log_dir)"
FILTER_PATH="$(platform_rclone_config_dir)/wiki-push-filters.txt"

# Resolve vault once; all vault git/conflict checks use this absolute path.
VAULT_PATH="$(resolve_vault_path)"

ROLE="${VS_ROLE:-}"
if role_val=$(config_value "vault_sync.role"); then
  [ -n "$role_val" ] && ROLE="$role_val"
fi

SERVICE_SCOPE="${VS_SERVICE_SCOPE:-user}"
if scope_val=$(config_value "vault_sync.service_scope"); then
  [ -n "$scope_val" ] && SERVICE_SCOPE="$scope_val"
fi

SNAPSHOT_SCRIPT="${VS_SNAPSHOT_SCRIPT:-}"
if snapshot_val=$(config_value "vault_sync.snapshot_script"); then
  [ -n "$snapshot_val" ] && SNAPSHOT_SCRIPT="$snapshot_val"
fi
if [ -z "$SNAPSHOT_SCRIPT" ]; then
  SNAPSHOT_SCRIPT="$SHARE_BIN/wiki-snapshot.sh"
  if [ ! -f "$SNAPSHOT_SCRIPT" ] && [ -f "/root/.hermes/scripts/wiki-snapshot-v3.sh" ]; then
    SNAPSHOT_SCRIPT="/root/.hermes/scripts/wiki-snapshot-v3.sh"
  fi
fi

# Installed snapshot profile path (S3 remote fallback for snapshotters). Process
# VS_SNAPSHOT_PROFILE still wins inside resolve_s3_remote.
SNAPSHOT_PROFILE="${VS_SNAPSHOT_PROFILE:-}"
if [ -z "$SNAPSHOT_PROFILE" ]; then
  if profile_val=$(config_value "vault_sync.snapshot_profile"); then
    [ -n "$profile_val" ] && SNAPSHOT_PROFILE="$profile_val"
  fi
fi

# Check 1: installed footprint
if [ "$ROLE" = "snapshotter" ]; then
  if [ -f "$SNAPSHOT_SCRIPT" ]; then
    add_check "vault_sync_installed" "Vault sync installed" "pass" "Found snapshot script: $SNAPSHOT_SCRIPT"
  else
    add_check "vault_sync_installed" "Vault sync installed" "error" "Snapshot script missing: $SNAPSHOT_SCRIPT"
  fi
else
  PUSH_SCRIPT="$SHARE_BIN/wiki-push.sh"
  if [ -f "$PUSH_SCRIPT" ]; then
    add_check "vault_sync_installed" "Vault sync installed" "pass" "Found: $PUSH_SCRIPT"
  else
    add_check "vault_sync_installed" "Vault sync installed" "error" "Script missing: $PUSH_SCRIPT"
  fi
fi

# Check 1b: presync terminal helper
PRESYNC_HELPER="$SHARE_BIN/wiki-sync.sh"
HOME_PRESYNC_HELPER="$HOME/bin/wiki-sync.sh"
presync_status="pass"
presync_details=()

if [ ! -f "$PRESYNC_HELPER" ]; then
  presync_status="warn"
  presync_details+=("installed helper missing: $PRESYNC_HELPER")
elif [ ! -x "$PRESYNC_HELPER" ]; then
  presync_status="warn"
  presync_details+=("installed helper not executable: $PRESYNC_HELPER")
else
  presync_details+=("installed helper ok: $PRESYNC_HELPER")
fi

if [ -L "$HOME_PRESYNC_HELPER" ]; then
  helper_target="$(readlink "$HOME_PRESYNC_HELPER" 2>/dev/null || true)"
  if [ ! -e "$HOME_PRESYNC_HELPER" ]; then
    presync_status="warn"
    presync_details+=("home helper broken symlink: $HOME_PRESYNC_HELPER -> ${helper_target:-unknown}")
  elif [ ! -x "$HOME_PRESYNC_HELPER" ]; then
    presync_status="warn"
    presync_details+=("home helper target not executable: $HOME_PRESYNC_HELPER -> ${helper_target:-unknown}")
  else
    presync_details+=("home helper symlink ok: $HOME_PRESYNC_HELPER -> ${helper_target:-unknown}")
  fi
elif [ -e "$HOME_PRESYNC_HELPER" ]; then
  if [ -x "$HOME_PRESYNC_HELPER" ]; then
    presync_details+=("home helper custom executable present: $HOME_PRESYNC_HELPER")
  else
    presync_status="warn"
    presync_details+=("home helper non-executable file: $HOME_PRESYNC_HELPER")
  fi
else
  presync_status="warn"
  presync_details+=("home helper missing: $HOME_PRESYNC_HELPER")
fi

presync_detail=""
for detail in "${presync_details[@]}"; do
  if [ -n "$presync_detail" ]; then
    presync_detail="$presync_detail; $detail"
  else
    presync_detail="$detail"
  fi
done

add_check "vault_sync_presync_helper" "Vault sync presync helper" "$presync_status" "$presync_detail"

# Check 1c: deployed script drift. The installer copies package scripts into
# the platform bin directory, so new package releases do not update running
# jobs until vault-sync-install is rerun.
check_installed_script_drift

# Check 2: scheduler enabled
if [ "$ROLE" = "snapshotter" ]; then
  if [ "$READ_ONLY" -eq 1 ]; then
    snapshot_user_timer="$HOME/.config/systemd/user/wiki-snapshot.timer"
    snapshot_system_timer="/etc/systemd/system/wiki-snapshot.timer"
    if [ -f "$snapshot_user_timer" ]; then
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "wiki-snapshot.timer unit file present (user scope, read-only mode)"
    elif [ -f "$snapshot_system_timer" ]; then
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "wiki-snapshot.timer unit file present (system scope, read-only mode)"
    else
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "wiki-snapshot.timer unit file missing (read-only mode)"
    fi
  else
    if [ "$VS_OS" != "linux" ]; then
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "snapshotter scheduler requires Linux"
    elif [ "$SERVICE_SCOPE" = "system" ]; then
      if systemctl is-enabled wiki-snapshot.timer >/dev/null 2>&1; then
        add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "systemd: wiki-snapshot.timer enabled (system)"
      else
        add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "systemd: wiki-snapshot.timer disabled or unavailable (system)"
      fi
    elif systemctl --user is-enabled wiki-snapshot.timer >/dev/null 2>&1; then
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "systemd: wiki-snapshot.timer enabled (user)"
    else
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "systemd: wiki-snapshot.timer disabled or unavailable (user)"
    fi
  fi
elif [ "$READ_ONLY" -eq 1 ]; then
  if [ "$VS_OS" = "macos" ]; then
    push_plist="$HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
    fetch_plist="$HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist"
    if [ -f "$push_plist" ] && [ -f "$fetch_plist" ]; then
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "launchd unit files present (read-only mode)"
    else
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "launchd unit files missing (read-only mode)"
    fi
  else
    push_timer="$HOME/.config/systemd/user/wiki-push.timer"
    fetch_timer="$HOME/.config/systemd/user/wiki-fetch.timer"
    if [ -f "$push_timer" ] && [ -f "$fetch_timer" ]; then
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "systemd timer unit files present (read-only mode)"
    else
      add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "systemd timer unit files missing (read-only mode)"
    fi
  fi
else
  if [ "$VS_OS" = "macos" ]; then
    push_job_json=$(platform_job_status "com.karlchow.wiki-push")
    fetch_job_json=$(platform_job_status "com.karlchow.wiki-fetch")
  else
    push_job_json=$(platform_job_status "wiki-push")
    fetch_job_json=$(platform_job_status "wiki-fetch")
  fi

  if printf '%s' "$push_job_json" | grep -q '"enabled": true' && printf '%s' "$fetch_job_json" | grep -q '"enabled": true'; then
    add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "pass" "Scheduler reports push+fetch enabled"
  else
    add_check "vault_sync_jobs_enabled" "Vault sync jobs enabled" "warn" "Scheduler reports one or more jobs disabled"
  fi
fi

# Check 2b: fuse refresh timer enabled (Linux only)
if [ "$VS_OS" = "macos" ]; then
  add_check "vault_sync_fuse_refresh_job" "Vault sync fuse refresh job" "pass" "macOS host — check skipped"
else
  if [ "$READ_ONLY" -eq 1 ]; then
    if [ "$SERVICE_SCOPE" = "system" ]; then
      fuse_timer="/etc/systemd/system/wiki-fuse-refresh.timer"
      fuse_service="/etc/systemd/system/wiki-fuse-refresh.service"
      fuse_scope="system"
    else
      fuse_timer="$HOME/.config/systemd/user/wiki-fuse-refresh.timer"
      fuse_service="$HOME/.config/systemd/user/wiki-fuse-refresh.service"
      fuse_scope="user"
    fi
    if [ -f "$fuse_timer" ] && [ -f "$fuse_service" ]; then
      add_check "vault_sync_fuse_refresh_job" "Vault sync fuse refresh job" "pass" "wiki-fuse-refresh unit files present ($fuse_scope scope, read-only mode)"
    else
      add_check "vault_sync_fuse_refresh_job" "Vault sync fuse refresh job" "warn" "wiki-fuse-refresh unit files missing ($fuse_scope scope, read-only mode)"
    fi
  else
    fuse_job_json=$(platform_job_status "wiki-fuse-refresh")
    if printf '%s' "$fuse_job_json" | grep -q '"enabled": true'; then
      add_check "vault_sync_fuse_refresh_job" "Vault sync fuse refresh job" "pass" "Scheduler reports wiki-fuse-refresh enabled"
    else
      add_check "vault_sync_fuse_refresh_job" "Vault sync fuse refresh job" "warn" "Scheduler reports wiki-fuse-refresh disabled"
    fi
  fi
fi

if [ "$ROLE" = "snapshotter" ]; then
  add_check "vault_sync_last_push_age" "Vault sync last push recency" "pass" "Snapshotter host — leaf wiki-push log not applicable"
  add_check "vault_sync_last_fetch_status" "Vault sync last fetch status" "pass" "Snapshotter host — leaf wiki-fetch-notify log not applicable"
  add_check "vault_sync_filter_present" "Vault sync filter file present" "pass" "Snapshotter host — leaf wiki-push filter not applicable"
else
  # Check 3: last push recency/result
  classify_log_tail "$LOG_DIR/wiki-push.log" "vault_sync_last_push_age" "Vault sync last push recency" 'OK push'

  # Additional fetch log status for operator visibility
  classify_log_tail "$LOG_DIR/wiki-fetch.log" "vault_sync_last_fetch_status" "Vault sync last fetch status" 'NOTIFY|OK behind'

  # Check 4: filter file presence
  if [ ! -f "$FILTER_PATH" ]; then
    add_check "vault_sync_filter_present" "Vault sync filter file present" "error" "Filter missing: $FILTER_PATH"
  else
    required_missing=()
    for needle in "remotely-save/data.json" ".skillwiki/sync.lock" ".skillwiki/memory/" ".skillwiki/memory-topics.json" ".claude/settings.local.json"; do
      if ! grep -q "$needle" "$FILTER_PATH"; then
        required_missing+=("$needle")
      fi
    done
    if [ "${#required_missing[@]}" -gt 0 ]; then
      add_check "vault_sync_filter_present" "Vault sync filter file present" "warn" "Missing excludes: ${required_missing[*]}"
    else
      add_check "vault_sync_filter_present" "Vault sync filter file present" "pass" "Required excludes present"
    fi
  fi
fi

# Check 5: snapshot guard (role-aware)
if [ "$ROLE" != "snapshotter" ]; then
  add_check "vault_sync_snapshot_guard" "Snapshot script guard" "pass" "Not a snapshotter host — check skipped"
else
  if [ ! -f "$SNAPSHOT_SCRIPT" ]; then
    add_check "vault_sync_snapshot_guard" "Snapshot script guard" "error" "Missing snapshot script: $SNAPSHOT_SCRIPT"
  elif grep -q -- '--max-delete' "$SNAPSHOT_SCRIPT"; then
    add_check "vault_sync_snapshot_guard" "Snapshot script guard" "pass" "--max-delete guard present in $SNAPSHOT_SCRIPT"
  else
    add_check "vault_sync_snapshot_guard" "Snapshot script guard" "error" "--max-delete guard missing"
  fi
fi

# Check 5b: runtime proof (manifest + package-source hashes + registration + live verify)
check_runtime_proof

# Check: store/host reachability (read-only; short timeouts)
# Always use absolute VAULT_PATH with git -C — never depend on process cwd.
github_reach="unknown"
github_detail="WIKI_PATH not set or vault missing"
REACH_SECS="$(reachability_timeout_secs)"
if [ -d "$VAULT_PATH/.git" ]; then
  if with_timeout "$REACH_SECS" git -C "$VAULT_PATH" ls-remote origin refs/heads/main >/dev/null 2>&1; then
    github_reach="ok"
    github_detail="git ls-remote origin main succeeded"
  elif with_timeout "$REACH_SECS" git -C "$VAULT_PATH" remote get-url origin >/dev/null 2>&1; then
    github_reach="unreachable"
    github_detail="GitHub ls-remote failed — local vault may still be usable"
  else
    github_reach="unknown"
    github_detail="No origin remote configured"
  fi
fi
add_check "reachability_github" "GitHub reachability" \
  "$( [ "$github_reach" = ok ] && printf pass || { [ "$github_reach" = unreachable ] && printf warn || printf pass; } )" \
  "$github_detail"

s3_reach="unknown"
s3_detail="S3 remote not configured — reachability probe skipped"
if ! resolve_s3_remote; then
  :
elif command -v rclone >/dev/null 2>&1; then
  if with_timeout "$REACH_SECS" rclone lsf "$S3_REMOTE" --max-depth 1 --files-only >/dev/null 2>&1; then
    s3_reach="ok"
    s3_detail="rclone lsf $S3_REMOTE succeeded (source: $S3_REMOTE_SOURCE)"
  else
    s3_reach="unreachable"
    s3_detail="S3 remote unreachable ($S3_REMOTE; source: $S3_REMOTE_SOURCE)"
  fi
else
  s3_detail="rclone not on PATH — configured S3 state unknown ($S3_REMOTE; source: $S3_REMOTE_SOURCE)"
fi
add_check "reachability_s3" "S3 reachability" \
  "$( [ "$s3_reach" = ok ] && printf pass || { [ "$s3_reach" = unreachable ] && printf warn || printf pass; } )" \
  "$s3_detail"

snapshotter_reach="not_checked"
snapshotter_detail="Snapshotter SSH check skipped (set VS_CHECK_SNAPSHOTTER=1 to probe)"
if is_true "${VS_CHECK_SNAPSHOTTER:-0}"; then
  SNAP_ALIAS="${VS_SNAPSHOTTER_SSH_ALIAS:-sg01}"
  if with_timeout "$REACH_SECS" ssh -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=accept-new "$SNAP_ALIAS" true >/dev/null 2>&1; then
    snapshotter_reach="ok"
    snapshotter_detail="SSH reachable via $SNAP_ALIAS"
  else
    snapshotter_reach="unreachable"
    snapshotter_detail="Snapshotter unreachable via $SNAP_ALIAS — not vault corruption"
  fi
fi
add_check "reachability_snapshotter" "Snapshotter reachability" \
  "$( [ "$snapshotter_reach" = ok ] && printf pass || { [ "$snapshotter_reach" = unreachable ] && printf warn || printf pass; } )" \
  "$snapshotter_detail"

local_git_status="pass"
local_git_detail="local vault state unknown"
if [ ! -d "$VAULT_PATH" ]; then
  local_git_status="warn"
  local_git_detail="Vault directory missing: $VAULT_PATH"
elif [ ! -d "$VAULT_PATH/.git" ]; then
  local_git_status="warn"
  local_git_detail="Not a git repository"
else
  dirty_n=0
  ahead_n=0
  behind_n=0
  dirty_n=$(git -C "$VAULT_PATH" status --porcelain 2>/dev/null | grep -c . || true)
  if ab=$(git -C "$VAULT_PATH" rev-list --left-right --count origin/HEAD...HEAD 2>/dev/null); then
    behind_n=$(printf '%s' "$ab" | awk '{print $1}')
    ahead_n=$(printf '%s' "$ab" | awk '{print $2}')
  fi
  if [ "$dirty_n" -gt 0 ]; then
    local_git_status="warn"
    local_git_detail="dirty=$dirty_n ahead=$ahead_n behind=$behind_n"
  elif [ "${ahead_n:-0}" -gt 0 ] || [ "${behind_n:-0}" -gt 0 ]; then
    local_git_status="warn"
    local_git_detail="clean worktree; ahead=$ahead_n behind=$behind_n"
  else
    local_git_detail="clean; ahead=0 behind=0"
  fi
fi
add_check "reachability_local_vault" "Local vault git state" "$local_git_status" "$local_git_detail"

# Check: vault conflict markers (all roles) — use absolute VAULT_PATH only
if [ ! -d "$VAULT_PATH" ]; then
  add_check "vault_sync_conflict_markers" "Vault conflict markers" "warn" "Vault directory missing: $VAULT_PATH"
else
  conflict_tmp="$(mktemp)"
  if vault_sync_scan_conflict_markers "$VAULT_PATH" "$conflict_tmp"; then
    add_check "vault_sync_conflict_markers" "Vault conflict markers" "pass" "No complete conflict-marker blocks"
    rm -f "$conflict_tmp"
  else
    scan_rc=$?
    if [ "$scan_rc" -eq 2 ]; then
      add_check "vault_sync_conflict_markers" "Vault conflict markers" "warn" "Scanner could not access vault: $VAULT_PATH"
      rm -f "$conflict_tmp"
    elif [ -s "$conflict_tmp" ]; then
      conflict_count="$(wc -l <"$conflict_tmp" | tr -d ' ')"
      first_line="$(head -n 1 "$conflict_tmp")"
      add_check "vault_sync_conflict_markers" "Vault conflict markers" "error" "${conflict_count} finding(s), first: ${first_line}"
      rm -f "$conflict_tmp"
    else
      add_check "vault_sync_conflict_markers" "Vault conflict markers" "warn" "Conflict marker scan failed (exit $scan_rc)"
      rm -f "$conflict_tmp"
    fi
  fi
fi

if [ "$RESTART_JOBS" -eq 1 ]; then
  restart_jobs
fi

pass_count=0
info_count=0
warn_count=0
error_count=0

for status in "${CHECK_STATUS[@]}"; do
  case "$status" in
    pass) pass_count=$((pass_count + 1)) ;;
    info) info_count=$((info_count + 1)) ;;
    warn) warn_count=$((warn_count + 1)) ;;
    error) error_count=$((error_count + 1)) ;;
  esac
done

if [ "$JSON_OUT" -eq 1 ]; then
  printf '{"checks":['
  idx=0
  total="${#CHECK_IDS[@]}"
  while [ "$idx" -lt "$total" ]; do
    [ "$idx" -gt 0 ] && printf ','
    id_json=$(json_escape "${CHECK_IDS[$idx]}")
    label_json=$(json_escape "${CHECK_LABELS[$idx]}")
    status_json=$(json_escape "${CHECK_STATUS[$idx]}")
    detail_json=$(json_escape "${CHECK_DETAIL[$idx]}")
    printf '{"id":%s,"label":%s,"status":%s,"detail":%s}' "$id_json" "$label_json" "$status_json" "$detail_json"
    idx=$((idx + 1))
  done
  printf '],"summary":{"pass":%d,"info":%d,"warn":%d,"error":%d},"humanHint":%s}\n' \
    "$pass_count" "$info_count" "$warn_count" "$error_count" "$(json_escape "vault-sync checks complete")"
else
  printf 'vault-sync status (os=%s read_only=%s vault=%s)\n' "$VS_OS" "$READ_ONLY" "$VAULT_PATH"
  printf '%-32s %-6s %s\n' "Check" "Status" "Detail"
  printf '%-32s %-6s %s\n' "-----" "------" "------"
  idx=0
  total="${#CHECK_IDS[@]}"
  while [ "$idx" -lt "$total" ]; do
    printf '%-32s %-6s %s\n' "${CHECK_IDS[$idx]}" "${CHECK_STATUS[$idx]}" "${CHECK_DETAIL[$idx]}"
    idx=$((idx + 1))
  done
  printf 'summary: pass=%d info=%d warn=%d error=%d\n' "$pass_count" "$info_count" "$warn_count" "$error_count"
fi
