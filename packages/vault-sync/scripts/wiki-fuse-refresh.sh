#!/bin/bash
# wiki-fuse-refresh.sh — keep rclone FUSE visibility within a bounded freshness SLA.
#
# Linux-focused helper that:
#   1) audits active rclone mount --dir-cache-time
#   2) optionally forgets stale VFS directory cache entries
#   3) optionally triggers `rclone rc vfs/refresh recursive=true dir=/`
#
# Intended to run under systemd timer (wiki-fuse-refresh.timer) and manually via
# the vault-fuse-freshness skill.

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
. "$SCRIPT_DIR/lib/platform.sh"
platform_detect_os

LOG_FILE="$(platform_log_dir)/wiki-fuse-refresh.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"
}

print() {
  printf '[wiki-fuse-refresh] %s\n' "$*"
  log "$*"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_true() {
  case "$(lower "${1:-}")" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

# Parse a duration string into seconds (supports: 10, 10m, 1h30m, 500ms).
duration_to_seconds() {
  local input
  input="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [ -n "$input" ] || return 1

  if printf '%s' "$input" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    printf '%s\n' "$input"
    return 0
  fi

  local rest="$input"
  local total="0"

  while [ -n "$rest" ]; do
    if printf '%s' "$rest" | grep -Eq '^([0-9]+([.][0-9]+)?)(ms|s|m|h|d|w)'; then
      local prefix
      prefix="$(printf '%s' "$rest" | sed -E 's/^([0-9]+([.][0-9]+)?)(ms|s|m|h|d|w).*/\1 \3/')"
      local value
      value="$(printf '%s' "$prefix" | awk '{print $1}')"
      local unit
      unit="$(printf '%s' "$prefix" | awk '{print $2}')"

      local factor
      case "$unit" in
        ms) factor="0.001" ;;
        s)  factor="1" ;;
        m)  factor="60" ;;
        h)  factor="3600" ;;
        d)  factor="86400" ;;
        w)  factor="604800" ;;
        *) return 1 ;;
      esac

      total="$(awk -v a="$total" -v b="$value" -v f="$factor" 'BEGIN { printf "%.6f", a + (b * f) }')"

      local seg_len
      seg_len="$(printf '%s' "$rest" | sed -E 's/^([0-9]+([.][0-9]+)?)(ms|s|m|h|d|w).*/\1\3/' | awk '{print length($0)}')"
      rest="${rest:$seg_len}"
    else
      return 1
    fi
  done

  awk -v v="$total" 'BEGIN {
    if (v + 0 == int(v + 0)) {
      printf "%d\n", v
    } else {
      s = sprintf("%.6f", v)
      sub(/0+$/, "", s)
      sub(/[.]$/, "", s)
      printf "%s\n", s
    }
  }'
}

seconds_gt() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'
}

find_rclone_mount_pid() {
  local pid
  pid="$(pgrep -f 'rclone.*mount' 2>/dev/null | head -n 1 || true)"
  [ -n "$pid" ] && printf '%s\n' "$pid"
}

rclone_token_stream() {
  local pid="$1"
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' '\n' < "/proc/$pid/cmdline"
    return 0
  fi
  ps -p "$pid" -o args= 2>/dev/null | tr ' ' '\n'
}

extract_flag_value() {
  local pid="$1"
  local flag="$2"
  local prev=""

  while IFS= read -r token; do
    [ -n "$token" ] || continue

    if [ "$prev" = "$flag" ]; then
      printf '%s\n' "$token"
      return 0
    fi

    case "$token" in
      "$flag="*)
        printf '%s\n' "${token#*=}"
        return 0
        ;;
    esac

    prev="$token"
  done < <(rclone_token_stream "$pid")

  return 1
}

has_flag() {
  local pid="$1"
  local flag="$2"

  while IFS= read -r token; do
    [ -n "$token" ] || continue
    if [ "$token" = "$flag" ]; then
      return 0
    fi
    case "$token" in
      "$flag="*) return 0 ;;
    esac
  done < <(rclone_token_stream "$pid")

  return 1
}

extract_mount_remote() {
  local pid="$1"
  local saw_mount=0

  while IFS= read -r token; do
    [ -n "$token" ] || continue

    if [ "$saw_mount" -eq 0 ]; then
      [ "$token" = "mount" ] && saw_mount=1
      continue
    fi

    case "$token" in
      --*) continue ;;
      /*) continue ;;
    esac

    case "$token" in
      *:*)
        printf '%s\n' "$token"
        return 0
        ;;
    esac
  done < <(rclone_token_stream "$pid")

  return 1
}

DRY_RUN=0
CHECK_ONLY=0
MAX_DIR_CACHE_RAW="${VS_FUSE_MAX_DIR_CACHE:-15m}"
RC_ADDR_OVERRIDE="${VS_FUSE_RC_ADDR:-}"
RC_TIMEOUT_SECONDS="${VS_FUSE_RC_TIMEOUT_SECONDS:-60}"
FORGET_DIRS=()

if [ -n "${VS_FUSE_FORGET_DIRS:-}" ]; then
  read -r -a FORGET_DIRS <<< "$VS_FUSE_FORGET_DIRS"
fi

usage() {
  cat <<USAGE
Usage: bash wiki-fuse-refresh.sh [options]

Options:
  --dry-run                Print planned actions only
  --check-only             Audit dir-cache-time only (no rc refresh)
  --max-dir-cache <dur>    Freshness threshold (default: 15m)
  --rc-addr <host:port>    Override rc endpoint (default: from mount flags, else 127.0.0.1:5572)
  --forget-dir <path>      Forget a VFS directory cache path before refresh (repeatable)
  --help                   Show this help

Environment overrides:
  VS_DRY_RUN=1|0
  VS_FUSE_CHECK_ONLY=1|0
  VS_FUSE_MAX_DIR_CACHE=<duration>
  VS_FUSE_RC_ADDR=<host:port>
  VS_FUSE_RC_TIMEOUT_SECONDS=<seconds>
  VS_FUSE_FORGET_DIRS="<path> [path...]"
USAGE
}

if is_true "${VS_DRY_RUN:-0}"; then
  DRY_RUN=1
fi
if is_true "${VS_FUSE_CHECK_ONLY:-0}"; then
  CHECK_ONLY=1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    --max-dir-cache)
      [ "$#" -ge 2 ] || { print "FATAL: --max-dir-cache requires a value"; exit 2; }
      MAX_DIR_CACHE_RAW="$2"
      shift 2
      ;;
    --rc-addr)
      [ "$#" -ge 2 ] || { print "FATAL: --rc-addr requires a value"; exit 2; }
      RC_ADDR_OVERRIDE="$2"
      shift 2
      ;;
    --forget-dir)
      [ "$#" -ge 2 ] || { print "FATAL: --forget-dir requires a value"; exit 2; }
      FORGET_DIRS+=("$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      print "FATAL: unknown argument: $1"
      exit 2
      ;;
  esac
done

if [ "$VS_OS" != "linux" ]; then
  print "skip: OS=$VS_OS (linux-only freshness workflow)"
  exit 0
fi

if ! command -v rclone >/dev/null 2>&1; then
  print "WARN: rclone not found in PATH"
  exit 0
fi

case "$RC_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    print "FATAL: VS_FUSE_RC_TIMEOUT_SECONDS must be an integer number of seconds"
    exit 2
    ;;
esac

MAX_DIR_CACHE_SECONDS="$(duration_to_seconds "$MAX_DIR_CACHE_RAW" 2>/dev/null || true)"
if [ -z "$MAX_DIR_CACHE_SECONDS" ]; then
  print "FATAL: cannot parse --max-dir-cache=$MAX_DIR_CACHE_RAW"
  exit 2
fi

RCLONE_PID="$(find_rclone_mount_pid || true)"
if [ -z "$RCLONE_PID" ]; then
  print "WARN: no running rclone mount process found"
  exit 0
fi

DIR_CACHE_RAW="$(extract_flag_value "$RCLONE_PID" --dir-cache-time 2>/dev/null || true)"
if [ -z "$DIR_CACHE_RAW" ]; then
  DIR_CACHE_RAW="5m"
fi
DIR_CACHE_SECONDS="$(duration_to_seconds "$DIR_CACHE_RAW" 2>/dev/null || true)"
if [ -z "$DIR_CACHE_SECONDS" ]; then
  print "WARN: cannot parse --dir-cache-time=$DIR_CACHE_RAW (pid=$RCLONE_PID)"
  exit 1
fi

if seconds_gt "$DIR_CACHE_SECONDS" "$MAX_DIR_CACHE_SECONDS"; then
  print "WARN: --dir-cache-time=$DIR_CACHE_RAW exceeds freshness threshold $MAX_DIR_CACHE_RAW (pid=$RCLONE_PID)"
  # Keep going so refresh still runs when possible; return non-zero at end.
  DIR_CACHE_STATUS=1
else
  print "OK: --dir-cache-time=$DIR_CACHE_RAW within freshness threshold $MAX_DIR_CACHE_RAW (pid=$RCLONE_PID)"
  DIR_CACHE_STATUS=0
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  if [ "$DIR_CACHE_STATUS" -eq 0 ]; then
    print "check-only: no refresh requested"
    exit 0
  fi
  print "check-only: returning non-zero due to stale dir-cache-time"
  exit 1
fi

if ! has_flag "$RCLONE_PID" --rc; then
  print "WARN: rclone mount pid=$RCLONE_PID has no --rc flag; cannot run vfs/refresh"
  [ "$DIR_CACHE_STATUS" -eq 0 ] && exit 0 || exit 1
fi

RC_ADDR="$RC_ADDR_OVERRIDE"
if [ -z "$RC_ADDR" ]; then
  RC_ADDR="$(extract_flag_value "$RCLONE_PID" --rc-addr 2>/dev/null || true)"
fi
if [ -z "$RC_ADDR" ]; then
  RC_ADDR="127.0.0.1:5572"
fi

RC_URL="$RC_ADDR"
case "$RC_URL" in
  http://*|https://*) ;;
  *) RC_URL="http://$RC_URL" ;;
esac

REMOTE="$(extract_mount_remote "$RCLONE_PID" 2>/dev/null || true)"

if ! command -v timeout >/dev/null 2>&1; then
  print "WARN: timeout not found in PATH; cannot run bounded rclone rc operations"
  [ "$DIR_CACHE_STATUS" -eq 0 ] && exit 1 || exit 1
fi

run_rclone_rc() {
  timeout "$RC_TIMEOUT_SECONDS" rclone rc --url "$RC_URL" "$@" 2>&1
}

if [ "$DRY_RUN" -eq 1 ]; then
  for forget_dir in "${FORGET_DIRS[@]}"; do
    if [ -n "$REMOTE" ]; then
      print "[dry-run] timeout $RC_TIMEOUT_SECONDS rclone rc --url $RC_URL vfs/forget dir=$forget_dir fs=$REMOTE"
    else
      print "[dry-run] timeout $RC_TIMEOUT_SECONDS rclone rc --url $RC_URL vfs/forget dir=$forget_dir"
    fi
  done
  if [ -n "$REMOTE" ]; then
    print "[dry-run] timeout $RC_TIMEOUT_SECONDS rclone rc --url $RC_URL vfs/refresh recursive=true dir=/ fs=$REMOTE"
  else
    print "[dry-run] timeout $RC_TIMEOUT_SECONDS rclone rc --url $RC_URL vfs/refresh recursive=true dir=/"
  fi
  [ "$DIR_CACHE_STATUS" -eq 0 ] && exit 0 || exit 1
fi

for forget_dir in "${FORGET_DIRS[@]}"; do
  if [ -n "$REMOTE" ]; then
    RC_OUT="$(run_rclone_rc vfs/forget "dir=$forget_dir" "fs=$REMOTE")"
  else
    RC_OUT="$(run_rclone_rc vfs/forget "dir=$forget_dir")"
  fi
  RC_CODE=$?

  if [ "$RC_CODE" -ne 0 ]; then
    print "FAIL: vfs/forget dir=$forget_dir rc=$RC_CODE url=$RC_URL"
    log "$RC_OUT"
    [ "$DIR_CACHE_STATUS" -eq 0 ] && exit "$RC_CODE" || exit 1
  fi

  print "OK: vfs/forget dir=$forget_dir completed via $RC_URL"
done

if [ -n "$REMOTE" ]; then
  RC_OUT="$(run_rclone_rc vfs/refresh recursive=true dir=/ "fs=$REMOTE")"
else
  RC_OUT="$(run_rclone_rc vfs/refresh recursive=true dir=/)"
fi
RC_CODE=$?

if [ "$RC_CODE" -ne 0 ]; then
  if printf '%s\n' "$RC_OUT" | grep -qi 'file does not exist'; then
    print "WARN: root vfs/refresh with dir=/ failed; retrying without dir=/"
    RC_OUT="$(run_rclone_rc vfs/refresh recursive=true)"
    RC_CODE=$?
  fi
fi

if [ "$RC_CODE" -ne 0 ]; then
  print "FAIL: vfs/refresh rc=$RC_CODE url=$RC_URL"
  log "$RC_OUT"
  [ "$DIR_CACHE_STATUS" -eq 0 ] && exit "$RC_CODE" || exit 1
fi

print "OK: vfs/refresh completed via $RC_URL"
[ "$DIR_CACHE_STATUS" -eq 0 ] && exit 0 || exit 1
