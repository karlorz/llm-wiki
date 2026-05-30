#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PLATFORM_LIB="$VAULT_SYNC_ROOT/scripts/lib/platform.sh"
FLEET_LIB="$VAULT_SYNC_ROOT/scripts/lib/fleet.sh"

if [ ! -f "$PLATFORM_LIB" ]; then
  echo "FATAL: missing platform helper: $PLATFORM_LIB" >&2
  exit 1
fi
if [ ! -f "$FLEET_LIB" ]; then
  echo "FATAL: missing fleet helper: $FLEET_LIB" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$PLATFORM_LIB"
# shellcheck source=/dev/null
source "$FLEET_LIB"

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_true() {
  case "$(lower "${1:-}")" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

print_cmd() {
  local rendered=""
  local arg
  for arg in "$@"; do
    rendered+=" $(printf '%q' "$arg")"
  done
  printf '%s\n' "${rendered# }"
}

log() {
  printf '[vault-sync-uninstall] %s\n' "$*"
}

fatal() {
  printf '[vault-sync-uninstall] FATAL: %s\n' "$*" >&2
  exit 1
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] $(print_cmd "$@")"
  else
    "$@"
  fi
}

set_env_key_raw() {
  local key="$1"
  local value="$2"
  local env_file="$HOME/.skillwiki/.env"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] set config: $key=$value"
    return 0
  fi

  mkdir -p "$(dirname "$env_file")"
  if [ ! -f "$env_file" ]; then
    printf '%s=%s\n' "$key" "$value" > "$env_file"
    return 0
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done=0 }
    $0 ~ "^" k "=" { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$env_file" > "$tmp"
  mv "$tmp" "$env_file"
}

set_vault_config() {
  local key="$1"
  local value="$2"

  if [ "$DRY_RUN" -eq 1 ]; then
    set_env_key_raw "$key" "$value"
    return 0
  fi

  if command -v skillwiki >/dev/null 2>&1; then
    if skillwiki config set "$key" "$value" >/dev/null 2>&1; then
      return 0
    fi
  fi

  set_env_key_raw "$key" "$value"
}

is_installed() {
  local env_file="$HOME/.skillwiki/.env"
  local share_bin="$1"

  if [ -f "$env_file" ] && grep -q '^vault_sync.installed=true$' "$env_file"; then
    return 0
  fi
  if [ -f "$share_bin/wiki-push.sh" ]; then
    return 0
  fi
  return 1
}

write_tombstone() {
  local removed_unit_path="$1"
  local label="$2"
  local tombstone_path="${removed_unit_path}.RETIRED.md"
  local now_iso
  now_iso="$(date -u +%FT%TZ)"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] write tombstone: $tombstone_path"
    return 0
  fi

  cat > "$tombstone_path" <<TOMBSTONE
# RETIRED — $label
- Retired: $now_iso
- Why: $REASON
- Restore: claude plugin install vault-sync@llm-wiki && /vault-sync-install
TOMBSTONE
}

PURGE_LOGS=0
if is_true "${VS_PURGE:-0}"; then
  PURGE_LOGS=1
fi
if is_true "${VS_KEEP_LOGS:-1}"; then
  KEEP_LOGS=1
else
  KEEP_LOGS=0
fi
if [ "$PURGE_LOGS" -eq 1 ]; then
  KEEP_LOGS=0
fi

DRY_RUN=0
if is_true "${VS_DRY_RUN:-0}"; then
  DRY_RUN=1
fi

FORCE_PROTECTED=0
if is_true "${VS_FORCE_PROTECTED:-0}"; then
  FORCE_PROTECTED=1
fi

REASON="${VS_REASON:-manual uninstall}"

usage() {
  cat <<USAGE
Usage: bash uninstall.sh [options]

Options:
  --keep-logs            Preserve logs (default)
  --purge                Remove logs as well
  --force-protected      Allow uninstall on protected hosts
  --reason <text>        Tombstone reason text
  --reason=<text>        Same as above
  --dry-run              Print removal plan and execute nothing
  --help                 Show this help

Environment overrides:
  VS_DRY_RUN=1|0
  VS_PURGE=1|0
  VS_KEEP_LOGS=1|0
  VS_FORCE_PROTECTED=1|0
  VS_REASON="text"
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep-logs)
      KEEP_LOGS=1
      PURGE_LOGS=0
      shift
      ;;
    --purge)
      PURGE_LOGS=1
      KEEP_LOGS=0
      shift
      ;;
    --force-protected)
      FORCE_PROTECTED=1
      shift
      ;;
    --reason)
      [ "$#" -ge 2 ] || fatal "--reason requires a value"
      REASON="$2"
      shift 2
      ;;
    --reason=*)
      REASON="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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
CURRENT_HOST="${VS_HOSTNAME:-$(hostname -s 2>/dev/null || hostname)}"

fleet_load || true
if fleet_is_protected "$CURRENT_HOST" && [ "$FORCE_PROTECTED" -ne 1 ]; then
  fatal "host '$CURRENT_HOST' is protected=true in fleet.yaml (use --force-protected to override)"
fi

if ! is_installed "$SHARE_BIN"; then
  if [ "$DRY_RUN" -eq 1 ]; then
    log "vault-sync not marked installed; dry-run removal candidates:"
    if [ "$VS_OS" = "macos" ]; then
      log "[dry-run] remove $HOME/Library/LaunchAgents/com.karlchow.wiki-push.plist"
      log "[dry-run] remove $HOME/Library/LaunchAgents/com.karlchow.wiki-fetch.plist"
    else
      log "[dry-run] remove $HOME/.config/systemd/user/wiki-push.service"
      log "[dry-run] remove $HOME/.config/systemd/user/wiki-push.timer"
      log "[dry-run] remove $HOME/.config/systemd/user/wiki-fetch.service"
      log "[dry-run] remove $HOME/.config/systemd/user/wiki-fetch.timer"
      log "[dry-run] remove $HOME/.config/systemd/user/wiki-fuse-refresh.service"
      log "[dry-run] remove $HOME/.config/systemd/user/wiki-fuse-refresh.timer"
    fi
    log "[dry-run] remove $SHARE_BIN"
  else
    log "vault-sync not installed; nothing to remove"
  fi
  exit 0
fi

log "OS=$VS_OS dry_run=$DRY_RUN purge_logs=$PURGE_LOGS"

if [ "$VS_OS" = "macos" ]; then
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  PUSH_PLIST="$LAUNCH_AGENTS_DIR/com.karlchow.wiki-push.plist"
  FETCH_PLIST="$LAUNCH_AGENTS_DIR/com.karlchow.wiki-fetch.plist"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] launchctl bootout gui/$UID/com.karlchow.wiki-push || true"
    log "[dry-run] launchctl bootout gui/$UID/com.karlchow.wiki-fetch || true"
  else
    launchctl bootout "gui/$UID/com.karlchow.wiki-push" >/dev/null 2>&1 || true
    launchctl bootout "gui/$UID/com.karlchow.wiki-fetch" >/dev/null 2>&1 || true
  fi

  if [ -f "$PUSH_PLIST" ]; then
    run_cmd rm -f "$PUSH_PLIST"
    write_tombstone "$PUSH_PLIST" "com.karlchow.wiki-push"
  fi
  if [ -f "$FETCH_PLIST" ]; then
    run_cmd rm -f "$FETCH_PLIST"
    write_tombstone "$FETCH_PLIST" "com.karlchow.wiki-fetch"
  fi
else
  SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] systemctl --user disable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer"
    log "[dry-run] systemctl --user daemon-reload"
  else
    systemctl --user disable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer >/dev/null 2>&1 || true
  fi

  for unit_name in wiki-push.service wiki-push.timer wiki-fetch.service wiki-fetch.timer wiki-fuse-refresh.service wiki-fuse-refresh.timer; do
    unit_path="$SYSTEMD_USER_DIR/$unit_name"
    if [ -f "$unit_path" ]; then
      run_cmd rm -f "$unit_path"
      write_tombstone "$unit_path" "$unit_name"
    fi
  done

  if [ "$DRY_RUN" -ne 1 ]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
fi

if [ -d "$SHARE_BIN" ]; then
  run_cmd rm -rf "$SHARE_BIN"
fi

if [ "$PURGE_LOGS" -eq 1 ]; then
  run_cmd rm -f "$LOG_DIR"/wiki-push.log* "$LOG_DIR"/wiki-fetch.log* "$LOG_DIR"/wiki-pull.log* "$LOG_DIR"/wiki-fuse-refresh.log* 2>/dev/null || true
fi

set_vault_config "vault_sync.installed" "false"
set_vault_config "vault_sync.role" "none"
set_vault_config "vault_sync.scheduler" "none"
set_vault_config "vault_sync.fuse_refresh_enabled" "false"
set_vault_config "vault_sync.fuse_refresh_interval" "none"
set_vault_config "vault_sync.fuse_max_dir_cache" "none"

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry-run only: no files or services were removed."
else
  log "vault-sync uninstalled."
fi
