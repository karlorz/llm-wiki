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
  printf '[vault-sync-install] %s\n' "$*"
}

warn() {
  printf '[vault-sync-install] WARN: %s\n' "$*" >&2
}

fatal() {
  printf '[vault-sync-install] FATAL: %s\n' "$*" >&2
  exit 1
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] $(print_cmd "$@")"
  else
    "$@"
  fi
}

write_file() {
  local dst="$1"
  local content="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] write file: $dst"
    return 0
  fi
  printf '%s' "$content" > "$dst"
}

replace_template() {
  local src="$1"
  local dst="$2"
  local esc_script esc_log esc_home
  esc_script=$(printf '%s' "$BIN_DIR" | sed -e 's/[\/&]/\\&/g')
  esc_log=$(printf '%s' "$LOG_DIR" | sed -e 's/[\/&]/\\&/g')
  esc_home=$(printf '%s' "$HOME" | sed -e 's/[\/&]/\\&/g')

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] render template: $src -> $dst"
    return 0
  fi

  local rendered
  rendered="$({
    sed \
      -e "s|@SCRIPT_DIR@|$esc_script|g" \
      -e "s|@LOG_DIR@|$esc_log|g" \
      -e "s|/Users/karlchow|$esc_home|g" \
      "$src"
  })"

  write_file "$dst" "$rendered"
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
    warn "skillwiki config set rejected '$key'; falling back to raw .env write"
  fi

  set_env_key_raw "$key" "$value"
}

ROLE="${VS_ROLE:-leaf}"
DRY_RUN=0
if is_true "${VS_DRY_RUN:-0}"; then
  DRY_RUN=1
fi
OVERRIDE_SNAPSHOTTER=0
if is_true "${VS_OVERRIDE_SNAPSHOTTER:-0}"; then
  OVERRIDE_SNAPSHOTTER=1
fi

usage() {
  cat <<USAGE
Usage: bash install.sh [options]

Options:
  --role <leaf|snapshotter>       Installation role (default: leaf)
  --role=<leaf|snapshotter>       Same as above
  --dry-run                       Print plan and execute nothing
  --execute                       Force execute mode
  --override-snapshotter          Allow replacing existing snapshotter
  --help                          Show this help

Environment overrides:
  VS_ROLE=leaf|snapshotter
  VS_DRY_RUN=1|0
  VS_OVERRIDE_SNAPSHOTTER=1|0
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)
      [ "$#" -ge 2 ] || fatal "--role requires a value"
      ROLE="$2"
      shift 2
      ;;
    --role=*)
      ROLE="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --execute)
      DRY_RUN=0
      shift
      ;;
    --override-snapshotter)
      OVERRIDE_SNAPSHOTTER=1
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

case "$ROLE" in
  leaf|snapshotter) ;;
  *) fatal "invalid role '$ROLE' (expected leaf or snapshotter)" ;;
esac

platform_detect_os
[ "$VS_OS" != "unsupported" ] || fatal "unsupported OS: $(uname -s)"

SCHEDULER="$(platform_scheduler)"
case "$VS_OS" in
  macos)
    [ "$SCHEDULER" = "launchd" ] || fatal "launchctl is not available"
    ;;
  linux)
    [ "$SCHEDULER" = "systemd" ] || fatal "systemd --user is not available"
    command -v loginctl >/dev/null 2>&1 || fatal "loginctl is required on Linux installs"
    ;;
esac

command -v git >/dev/null 2>&1 || fatal "git not found in PATH"
if ! command -v rclone >/dev/null 2>&1; then
  warn "rclone not found in PATH — install proceeds, but sync jobs will fail until rclone is installed"
fi

CURRENT_HOST="${VS_HOSTNAME:-$(hostname -s 2>/dev/null || hostname)}"

fleet_load || true
if [ "$ROLE" = "snapshotter" ]; then
  if ! fleet_validate_install "$CURRENT_HOST" "$ROLE" "$( [ "$OVERRIDE_SNAPSHOTTER" -eq 1 ] && echo true || echo false )"; then
    fatal "fleet snapshotter validation failed"
  fi
fi
if fleet_is_protected "$CURRENT_HOST"; then
  warn "host '$CURRENT_HOST' is marked protected=true in fleet.yaml"
fi

SHARE_DIR="$(platform_share_dir)"
BIN_DIR="$SHARE_DIR/bin"
LOG_DIR="$(platform_log_dir)"
RCLONE_DIR="$(platform_rclone_config_dir)"
FILTER_SRC="$VAULT_SYNC_ROOT/filters/wiki-push-filters.txt"
FILTER_DST="$RCLONE_DIR/wiki-push-filters.txt"

[ -f "$FILTER_SRC" ] || fatal "missing filter source file: $FILTER_SRC"

LAUNCHD_SRC_DIR="$VAULT_SYNC_ROOT/service-units/launchd"
SYSTEMD_SRC_DIR="$VAULT_SYNC_ROOT/service-units/systemd"

log "OS=$VS_OS scheduler=$SCHEDULER role=$ROLE dry_run=$DRY_RUN"
log "Plan: deploy scripts to $BIN_DIR"
log "Plan: deploy filter to $FILTER_DST"
if [ "$VS_OS" = "macos" ]; then
  log "Plan: render launchd units in $HOME/Library/LaunchAgents"
else
  log "Plan: render systemd user units in $HOME/.config/systemd/user"
  log "Plan: run loginctl enable-linger $USER"
fi

run_cmd mkdir -p "$BIN_DIR" "$LOG_DIR" "$RCLONE_DIR"
run_cmd cp "$VAULT_SYNC_ROOT/scripts/"*.sh "$BIN_DIR/"
if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] rm -rf $BIN_DIR/lib"
  log "[dry-run] cp -R $VAULT_SYNC_ROOT/scripts/lib $BIN_DIR/lib"
else
  rm -rf "$BIN_DIR/lib"
  cp -R "$VAULT_SYNC_ROOT/scripts/lib" "$BIN_DIR/lib"
fi
run_cmd chmod +x "$BIN_DIR/"*.sh
run_cmd chmod +x "$BIN_DIR/lib/"*.sh
run_cmd cp "$FILTER_SRC" "$FILTER_DST"

if [ "$VS_OS" = "macos" ]; then
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  PUSH_TMPL="$LAUNCHD_SRC_DIR/com.karlchow.wiki-push.plist.tmpl"
  FETCH_TMPL="$LAUNCHD_SRC_DIR/com.karlchow.wiki-fetch.plist.tmpl"
  PUSH_PLIST="$LAUNCH_AGENTS_DIR/com.karlchow.wiki-push.plist"
  FETCH_PLIST="$LAUNCH_AGENTS_DIR/com.karlchow.wiki-fetch.plist"

  run_cmd mkdir -p "$LAUNCH_AGENTS_DIR"
  replace_template "$PUSH_TMPL" "$PUSH_PLIST"
  replace_template "$FETCH_TMPL" "$FETCH_PLIST"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] launchctl bootout gui/$UID/com.karlchow.wiki-push || true"
    log "[dry-run] launchctl bootout gui/$UID/com.karlchow.wiki-fetch || true"
    log "[dry-run] launchctl bootstrap gui/$UID $PUSH_PLIST"
    log "[dry-run] launchctl bootstrap gui/$UID $FETCH_PLIST"
  else
    launchctl bootout "gui/$UID/com.karlchow.wiki-push" >/dev/null 2>&1 || true
    launchctl bootout "gui/$UID/com.karlchow.wiki-fetch" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$UID" "$PUSH_PLIST"
    launchctl bootstrap "gui/$UID" "$FETCH_PLIST"
  fi
else
  SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
  run_cmd mkdir -p "$SYSTEMD_USER_DIR"

  replace_template "$SYSTEMD_SRC_DIR/wiki-push.service" "$SYSTEMD_USER_DIR/wiki-push.service"
  replace_template "$SYSTEMD_SRC_DIR/wiki-push.timer" "$SYSTEMD_USER_DIR/wiki-push.timer"
  replace_template "$SYSTEMD_SRC_DIR/wiki-fetch.service" "$SYSTEMD_USER_DIR/wiki-fetch.service"
  replace_template "$SYSTEMD_SRC_DIR/wiki-fetch.timer" "$SYSTEMD_USER_DIR/wiki-fetch.timer"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] loginctl enable-linger $USER"
    log "[dry-run] systemctl --user daemon-reload"
    log "[dry-run] systemctl --user enable --now wiki-push.timer wiki-fetch.timer"
  else
    loginctl enable-linger "$USER" || fatal "loginctl enable-linger $USER failed"
    systemctl --user daemon-reload
    systemctl --user enable --now wiki-push.timer wiki-fetch.timer
  fi
fi

set_vault_config "vault_sync.installed" "true"
set_vault_config "vault_sync.role" "$ROLE"
set_vault_config "vault_sync.scheduler" "$SCHEDULER"

log "Install plan complete."
if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry-run only: no files or services were modified."
else
  log "vault-sync installed successfully."
fi
