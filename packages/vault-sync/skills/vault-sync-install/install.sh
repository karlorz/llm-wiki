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
  local esc_script esc_log esc_home esc_launchd_path
  esc_script=$(printf '%s' "$BIN_DIR" | sed -e 's/[\/&]/\\&/g')
  esc_log=$(printf '%s' "$LOG_DIR" | sed -e 's/[\/&]/\\&/g')
  esc_home=$(printf '%s' "$HOME" | sed -e 's/[\/&]/\\&/g')
  esc_launchd_path=$(printf '%s' "$(launchd_path)" | sed -e 's/[\/&]/\\&/g')

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] render template: $src -> $dst"
    return 0
  fi

  local rendered
  rendered="$({
    sed \
      -e "s|@SCRIPT_DIR@|$esc_script|g" \
      -e "s|@LOG_DIR@|$esc_log|g" \
      -e "s|@HOME@|$esc_home|g" \
      -e "s|@LAUNCHD_PATH@|$esc_launchd_path|g" \
      -e "s|/Users/karlchow|$esc_home|g" \
      "$src"
  })"

  write_file "$dst" "$rendered"
}

launchd_path() {
  local fallback="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local node_path node_dir

  node_path="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_path" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  node_dir="$(dirname "$node_path")"
  case ":$fallback:" in
    *":$node_dir:"*) printf '%s\n' "$fallback" ;;
    *) printf '%s:%s\n' "$node_dir" "$fallback" ;;
  esac
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
MODE="${VS_MODE:-full}"
SERVICE_SCOPE="${VS_SERVICE_SCOPE:-auto}"
VAULT_PATH="${VS_VAULT_PATH:-${WIKI_PATH:-$HOME/wiki}}"
FUSE_MAX_DIR_CACHE="${VS_FUSE_MAX_DIR_CACHE:-15m}"
SNAPSHOT_PROFILE_PATH=""
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
  --mode <full|fuse-only>        Install mode (default: full)
  --mode=<full|fuse-only>        Same as above
  --role <leaf|snapshotter>       Installation role (default: leaf)
  --role=<leaf|snapshotter>       Same as above
  --service-scope <auto|user|system>
                                  systemd scope for Linux FUSE-only installs (default: auto)
  --service-scope=<auto|user|system>
                                  Same as above
  --vault-path <path>             Target wiki path for FUSE-only mount guard (default: ~/wiki)
  --vault-path=<path>             Same as above
  --max-dir-cache <duration>      FUSE freshness threshold (default: 15m)
  --max-dir-cache=<duration>      Same as above
  --dry-run                       Print plan and execute nothing
  --execute                       Force execute mode
  --override-snapshotter          Allow replacing existing snapshotter
  --help                          Show this help

Environment overrides:
  VS_MODE=full|fuse-only
  VS_ROLE=leaf|snapshotter
  VS_SERVICE_SCOPE=auto|user|system
  VS_VAULT_PATH=<path>
  VS_FUSE_MAX_DIR_CACHE=<duration>
  VS_DRY_RUN=1|0
  VS_OVERRIDE_SNAPSHOTTER=1|0
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      [ "$#" -ge 2 ] || fatal "--mode requires a value"
      MODE="$2"
      shift 2
      ;;
    --mode=*)
      MODE="${1#*=}"
      shift
      ;;
    --role)
      [ "$#" -ge 2 ] || fatal "--role requires a value"
      ROLE="$2"
      shift 2
      ;;
    --role=*)
      ROLE="${1#*=}"
      shift
      ;;
    --service-scope)
      [ "$#" -ge 2 ] || fatal "--service-scope requires a value"
      SERVICE_SCOPE="$2"
      shift 2
      ;;
    --service-scope=*)
      SERVICE_SCOPE="${1#*=}"
      shift
      ;;
    --vault-path)
      [ "$#" -ge 2 ] || fatal "--vault-path requires a value"
      VAULT_PATH="$2"
      shift 2
      ;;
    --vault-path=*)
      VAULT_PATH="${1#*=}"
      shift
      ;;
    --max-dir-cache)
      [ "$#" -ge 2 ] || fatal "--max-dir-cache requires a value"
      FUSE_MAX_DIR_CACHE="$2"
      shift 2
      ;;
    --max-dir-cache=*)
      FUSE_MAX_DIR_CACHE="${1#*=}"
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

MODE="$(lower "$MODE")"
SERVICE_SCOPE="$(lower "$SERVICE_SCOPE")"
ROLE="$(lower "$ROLE")"

case "$MODE" in
  full|fuse-only) ;;
  *) fatal "invalid mode '$MODE' (expected full or fuse-only)" ;;
esac

case "$SERVICE_SCOPE" in
  auto|user|system) ;;
  *) fatal "invalid service scope '$SERVICE_SCOPE' (expected auto, user, or system)" ;;
esac

case "$ROLE" in
  leaf|snapshotter) ;;
  *) fatal "invalid role '$ROLE' (expected leaf or snapshotter)" ;;
esac

if [ "$MODE" = "fuse-only" ] && [ "$ROLE" = "snapshotter" ]; then
  fatal "fuse-only mode does not install snapshotter role"
fi

platform_detect_os
[ "$VS_OS" != "unsupported" ] || fatal "unsupported OS: $(uname -s)"

if [ "$MODE" = "fuse-only" ]; then
  [ "$VS_OS" = "linux" ] || fatal "fuse-only mode requires Linux"
  command -v systemctl >/dev/null 2>&1 || fatal "systemctl is required for Linux FUSE-only installs"
  SCHEDULER="systemd"
  if [ "$SERVICE_SCOPE" = "auto" ]; then
    if [ "$(id -u)" = "0" ]; then
      SERVICE_SCOPE="system"
    else
      SERVICE_SCOPE="user"
    fi
  fi
  if [ "$SERVICE_SCOPE" = "user" ]; then
    systemctl --user >/dev/null 2>&1 || fatal "systemd --user is not available"
    command -v loginctl >/dev/null 2>&1 || fatal "loginctl is required for Linux user installs"
  elif [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" != "0" ]; then
    fatal "system service scope requires root"
  fi
else
  SCHEDULER="$(platform_scheduler)"
  case "$VS_OS" in
    macos)
      [ "$SCHEDULER" = "launchd" ] || fatal "launchctl is not available"
      ;;
    linux)
      if [ "$ROLE" = "snapshotter" ]; then
        if [ "$SERVICE_SCOPE" = "auto" ]; then
          if [ "$(id -u)" = "0" ]; then
            SERVICE_SCOPE="system"
          else
            SERVICE_SCOPE="user"
          fi
        fi
        case "$SERVICE_SCOPE" in
          user)
            [ "$SCHEDULER" = "systemd" ] || fatal "systemd --user is not available"
            command -v loginctl >/dev/null 2>&1 || fatal "loginctl is required on Linux user installs"
            ;;
          system)
            command -v systemctl >/dev/null 2>&1 || fatal "systemctl is required for Linux system installs"
            if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" != "0" ]; then
              fatal "system service scope requires root"
            fi
            ;;
        esac
      else
        SERVICE_SCOPE="user"
        [ "$SCHEDULER" = "systemd" ] || fatal "systemd --user is not available"
        command -v loginctl >/dev/null 2>&1 || fatal "loginctl is required on Linux installs"
      fi
      ;;
  esac
fi

if [ "$MODE" = "full" ]; then
  command -v git >/dev/null 2>&1 || fatal "git not found in PATH"
fi
if ! command -v rclone >/dev/null 2>&1; then
  warn "rclone not found in PATH — install proceeds, but sync jobs will fail until rclone is installed"
fi

CURRENT_HOST="${VS_HOSTNAME:-$(hostname -s 2>/dev/null || hostname)}"
SNAPSHOT_PROFILE_PATH="/etc/vault-sync/profiles/${CURRENT_HOST}-snapshotter.env"

if [ "$MODE" = "full" ]; then
  fleet_load || true
  if [ "$ROLE" = "snapshotter" ]; then
    if ! fleet_validate_install "$CURRENT_HOST" "$ROLE" "$( [ "$OVERRIDE_SNAPSHOTTER" -eq 1 ] && echo true || echo false )"; then
      fatal "fleet snapshotter validation failed"
    fi
  fi
  if fleet_is_protected "$CURRENT_HOST"; then
    warn "host '$CURRENT_HOST' is marked protected=true in fleet.yaml"
  fi
fi

SHARE_DIR="$(platform_share_dir)"
BIN_DIR="$SHARE_DIR/bin"
LOG_DIR="$(platform_log_dir)"
RCLONE_DIR="$(platform_rclone_config_dir)"
FILTER_SRC="$VAULT_SYNC_ROOT/filters/wiki-push-filters.txt"
FILTER_DST="$RCLONE_DIR/wiki-push-filters.txt"

LAUNCHD_SRC_DIR="$VAULT_SYNC_ROOT/service-units/launchd"
SYSTEMD_SRC_DIR="$VAULT_SYNC_ROOT/service-units/systemd"

copy_script_lib() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] rm -rf $BIN_DIR/lib"
    log "[dry-run] cp -R $VAULT_SYNC_ROOT/scripts/lib $BIN_DIR/lib"
  else
    rm -rf "$BIN_DIR/lib"
    cp -R "$VAULT_SYNC_ROOT/scripts/lib" "$BIN_DIR/lib"
  fi
  run_cmd chmod +x "$BIN_DIR/lib/"*.sh
}

install_presync_helper() {
  local src="$VAULT_SYNC_ROOT/skills/vault-presync/wiki-sync.sh"
  local dst="$BIN_DIR/wiki-sync.sh"
  local home_bin="$HOME/bin"
  local home_link="$home_bin/wiki-sync.sh"

  [ -f "$src" ] || fatal "missing presync helper source: $src"

  log "Plan: deploy presync helper to $dst"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] cp $(printf '%q' "$src") $(printf '%q' "$dst")"
    log "[dry-run] chmod +x $(printf '%q' "$dst")"
  else
    cp "$src" "$dst"
    chmod +x "$dst"
  fi

  if [ -e "$home_bin" ] && [ ! -d "$home_bin" ]; then
    warn "not creating convenience helper because $home_bin exists and is not a directory"
    return 0
  fi

  if [ -e "$home_link" ] && [ ! -L "$home_link" ] && ! cmp -s "$home_link" "$src"; then
    warn "not replacing non-symlink user file: $home_link"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] mkdir -p $(printf '%q' "$home_bin")"
    log "[dry-run] ln -sfn $(printf '%q' "$dst") $(printf '%q' "$home_link")"
  else
    mkdir -p "$home_bin"
    if [ -e "$home_link" ] && [ ! -L "$home_link" ]; then
      rm -f "$home_link"
    fi
    ln -sfn "$dst" "$home_link"
  fi
}

guard_fuse_only_target() {
  command -v findmnt >/dev/null 2>&1 || fatal "findmnt is required for FUSE-only mount guard"

  local fs_type
  fs_type="$(findmnt -T "$VAULT_PATH" -n -o FSTYPE 2>/dev/null | head -n 1 || true)"
  if [ "$fs_type" != "fuse.rclone" ]; then
    fatal "target vault $VAULT_PATH fs type '${fs_type:-unknown}' is not fuse.rclone"
  fi
}

require_active_rclone_mount() {
  command -v pgrep >/dev/null 2>&1 || fatal "pgrep is required to validate the active rclone mount"
  if ! pgrep -f 'rclone.*mount' >/dev/null 2>&1; then
    fatal "no active rclone mount process found for FUSE-only install"
  fi
}

install_fuse_only() {
  guard_fuse_only_target

  local systemd_dir enable_cmd daemon_cmd
  if [ "$SERVICE_SCOPE" = "system" ]; then
    systemd_dir="/etc/systemd/system"
    daemon_cmd=(systemctl daemon-reload)
    enable_cmd=(systemctl enable --now wiki-fuse-refresh.timer)
  else
    systemd_dir="$HOME/.config/systemd/user"
    daemon_cmd=(systemctl --user daemon-reload)
    enable_cmd=(systemctl --user enable --now wiki-fuse-refresh.timer)
  fi

  log "OS=$VS_OS scheduler=$SCHEDULER mode=fuse-only service_scope=$SERVICE_SCOPE dry_run=$DRY_RUN"
  log "Target vault=$VAULT_PATH"
  log "Plan: deploy wiki-fuse-refresh.sh to $BIN_DIR"
  log "Plan: render systemd $SERVICE_SCOPE units in $systemd_dir"
  log "Plan: install wiki-fuse-refresh.timer (5min)"

  run_cmd mkdir -p "$BIN_DIR" "$LOG_DIR" "$systemd_dir"
  run_cmd cp "$VAULT_SYNC_ROOT/scripts/wiki-fuse-refresh.sh" "$BIN_DIR/wiki-fuse-refresh.sh"
  copy_script_lib
  run_cmd chmod +x "$BIN_DIR/wiki-fuse-refresh.sh"

  replace_template "$SYSTEMD_SRC_DIR/wiki-fuse-refresh.service" "$systemd_dir/wiki-fuse-refresh.service"
  replace_template "$SYSTEMD_SRC_DIR/wiki-fuse-refresh.timer" "$systemd_dir/wiki-fuse-refresh.timer"

  if [ "$SERVICE_SCOPE" = "user" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] loginctl enable-linger $USER"
    else
      loginctl enable-linger "$USER" || fatal "loginctl enable-linger $USER failed"
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] verify active rclone mount process exists"
    log "[dry-run] $BIN_DIR/wiki-fuse-refresh.sh --dry-run --max-dir-cache $FUSE_MAX_DIR_CACHE"
    log "[dry-run] $(print_cmd "${daemon_cmd[@]}")"
    log "[dry-run] $(print_cmd "${enable_cmd[@]}")"
  else
    require_active_rclone_mount
    if "$BIN_DIR/wiki-fuse-refresh.sh" --dry-run --max-dir-cache "$FUSE_MAX_DIR_CACHE" >/dev/null 2>&1; then
      log "Validated fuse refresh prerequisites (<=${FUSE_MAX_DIR_CACHE}, rc available)"
    else
      fatal "Fuse refresh validation failed. Run: $BIN_DIR/wiki-fuse-refresh.sh --dry-run --max-dir-cache $FUSE_MAX_DIR_CACHE"
    fi
    "${daemon_cmd[@]}"
    "${enable_cmd[@]}"
  fi

  set_vault_config "vault_sync.scheduler" "$SCHEDULER"
  set_vault_config "vault_sync.fuse_refresh_enabled" "true"
  set_vault_config "vault_sync.fuse_refresh_interval" "300s"
  set_vault_config "vault_sync.fuse_max_dir_cache" "$FUSE_MAX_DIR_CACHE"
  set_vault_config "vault_sync.fuse_service_scope" "$SERVICE_SCOPE"

  log "FUSE-only install plan complete."
  if [ "$DRY_RUN" -eq 1 ]; then
    log "Dry-run only: no files or services were modified."
  else
    log "vault-sync FUSE refresh installed successfully."
  fi
}

if [ "$MODE" = "fuse-only" ]; then
  install_fuse_only
  exit 0
fi

[ -f "$FILTER_SRC" ] || fatal "missing filter source file: $FILTER_SRC"

log "OS=$VS_OS scheduler=$SCHEDULER mode=full role=$ROLE dry_run=$DRY_RUN"
log "Plan: deploy scripts to $BIN_DIR"
log "Plan: install wiki-sync helper in $BIN_DIR and $HOME/bin"
log "Plan: deploy filter to $FILTER_DST"
if [ "$VS_OS" = "macos" ]; then
  log "Plan: render launchd units in $HOME/Library/LaunchAgents"
else
  if [ "$ROLE" = "snapshotter" ]; then
    if [ "$SERVICE_SCOPE" = "system" ]; then
      log "Plan: render systemd system units in /etc/systemd/system"
    else
      log "Plan: render systemd user units in $HOME/.config/systemd/user"
      log "Plan: run loginctl enable-linger $USER"
    fi
    log "Plan: install wiki-snapshot.timer (30min)"
    log "Plan: install wiki-fuse-refresh.timer (5min)"
  else
    log "Plan: render systemd user units in $HOME/.config/systemd/user"
    log "Plan: install wiki-fuse-refresh.timer (5min)"
    log "Plan: run loginctl enable-linger $USER"
  fi
fi

run_cmd mkdir -p "$BIN_DIR" "$LOG_DIR" "$RCLONE_DIR"
run_cmd cp "$VAULT_SYNC_ROOT/scripts/"*.sh "$BIN_DIR/"
copy_script_lib
run_cmd chmod +x "$BIN_DIR/"*.sh
install_presync_helper
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
  if [ "$ROLE" = "snapshotter" ]; then
    if [ "$SERVICE_SCOPE" = "system" ]; then
      SYSTEMD_DIR="/etc/systemd/system"
      DAEMON_RELOAD_CMD=(systemctl daemon-reload)
      ENABLE_TIMERS_CMD=(systemctl enable --now wiki-snapshot.timer wiki-fuse-refresh.timer)
    else
      SYSTEMD_DIR="$HOME/.config/systemd/user"
      DAEMON_RELOAD_CMD=(systemctl --user daemon-reload)
      ENABLE_TIMERS_CMD=(systemctl --user enable --now wiki-snapshot.timer wiki-fuse-refresh.timer)
    fi

    run_cmd mkdir -p "$SYSTEMD_DIR"

    replace_template "$SYSTEMD_SRC_DIR/wiki-snapshot.service" "$SYSTEMD_DIR/wiki-snapshot.service"
    replace_template "$SYSTEMD_SRC_DIR/wiki-snapshot.timer" "$SYSTEMD_DIR/wiki-snapshot.timer"
    replace_template "$SYSTEMD_SRC_DIR/wiki-fuse-refresh.service" "$SYSTEMD_DIR/wiki-fuse-refresh.service"
    replace_template "$SYSTEMD_SRC_DIR/wiki-fuse-refresh.timer" "$SYSTEMD_DIR/wiki-fuse-refresh.timer"

    if [ "$DRY_RUN" -eq 1 ]; then
      if [ "$SERVICE_SCOPE" = "user" ]; then
        log "[dry-run] loginctl enable-linger $USER"
      fi
      log "[dry-run] $(print_cmd "${DAEMON_RELOAD_CMD[@]}")"
      log "[dry-run] $(print_cmd "${ENABLE_TIMERS_CMD[@]}")"
      log "[dry-run] $BIN_DIR/wiki-fuse-refresh.sh --check-only --max-dir-cache 15m"
    else
      if [ "$SERVICE_SCOPE" = "user" ]; then
        loginctl enable-linger "$USER" || fatal "loginctl enable-linger $USER failed"
      fi
      "${DAEMON_RELOAD_CMD[@]}"
      "${ENABLE_TIMERS_CMD[@]}"
      if [ -x "$BIN_DIR/wiki-fuse-refresh.sh" ]; then
        if "$BIN_DIR/wiki-fuse-refresh.sh" --check-only --max-dir-cache 15m >/dev/null 2>&1; then
          log "Validated fuse freshness envelope (<=15m) via wiki-fuse-refresh --check-only"
        else
          warn "Fuse freshness validation reported drift (>15m or no rc visibility). Run: $BIN_DIR/wiki-fuse-refresh.sh --check-only"
        fi
      else
        warn "Missing $BIN_DIR/wiki-fuse-refresh.sh; cannot validate fuse freshness envelope"
      fi
    fi
  else
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    run_cmd mkdir -p "$SYSTEMD_USER_DIR"

    replace_template "$SYSTEMD_SRC_DIR/wiki-push.service" "$SYSTEMD_USER_DIR/wiki-push.service"
    replace_template "$SYSTEMD_SRC_DIR/wiki-push.timer" "$SYSTEMD_USER_DIR/wiki-push.timer"
    replace_template "$SYSTEMD_SRC_DIR/wiki-fetch.service" "$SYSTEMD_USER_DIR/wiki-fetch.service"
    replace_template "$SYSTEMD_SRC_DIR/wiki-fetch.timer" "$SYSTEMD_USER_DIR/wiki-fetch.timer"
    replace_template "$SYSTEMD_SRC_DIR/wiki-fuse-refresh.service" "$SYSTEMD_USER_DIR/wiki-fuse-refresh.service"
    replace_template "$SYSTEMD_SRC_DIR/wiki-fuse-refresh.timer" "$SYSTEMD_USER_DIR/wiki-fuse-refresh.timer"

    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] loginctl enable-linger $USER"
      log "[dry-run] systemctl --user daemon-reload"
      log "[dry-run] systemctl --user enable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer"
      log "[dry-run] $BIN_DIR/wiki-fuse-refresh.sh --check-only --max-dir-cache 15m"
    else
      loginctl enable-linger "$USER" || fatal "loginctl enable-linger $USER failed"
      systemctl --user daemon-reload
      systemctl --user enable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer
      if [ -x "$BIN_DIR/wiki-fuse-refresh.sh" ]; then
        if "$BIN_DIR/wiki-fuse-refresh.sh" --check-only --max-dir-cache 15m >/dev/null 2>&1; then
          log "Validated fuse freshness envelope (<=15m) via wiki-fuse-refresh --check-only"
        else
          warn "Fuse freshness validation reported drift (>15m or no rc visibility). Run: $BIN_DIR/wiki-fuse-refresh.sh --check-only"
        fi
      else
        warn "Missing $BIN_DIR/wiki-fuse-refresh.sh; cannot validate fuse freshness envelope"
      fi
    fi
  fi
fi

set_vault_config "vault_sync.installed" "true"
set_vault_config "vault_sync.role" "$ROLE"
set_vault_config "vault_sync.scheduler" "$SCHEDULER"
if [ "$VS_OS" = "linux" ]; then
  set_vault_config "vault_sync.service_scope" "$SERVICE_SCOPE"
  set_vault_config "vault_sync.fuse_refresh_enabled" "true"
  set_vault_config "vault_sync.fuse_refresh_interval" "300s"
  set_vault_config "vault_sync.fuse_max_dir_cache" "15m"
  set_vault_config "vault_sync.fuse_service_scope" "$SERVICE_SCOPE"
  if [ "$ROLE" = "snapshotter" ]; then
    set_vault_config "vault_sync.snapshot_profile" "$SNAPSHOT_PROFILE_PATH"
    set_vault_config "vault_sync.snapshot_script" "$BIN_DIR/wiki-snapshot.sh"
  fi
else
  set_vault_config "vault_sync.fuse_refresh_enabled" "false"
fi

log "Install plan complete."
if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry-run only: no files or services were modified."
else
  log "vault-sync installed successfully."
fi
