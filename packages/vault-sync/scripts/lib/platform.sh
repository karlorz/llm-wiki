#!/bin/sh
# platform.sh — Cross-platform abstraction for vault-sync scripts.
#
# Sourced by all vault-sync scripts. Provides OS detection, normalized
# paths, stat wrappers, notification shim, scheduler abstraction, and
# feature prerequisites.
#
# Works in bash and /bin/sh (dash on Debian). No external deps beyond
# what vault-sync itself requires (rclone, git).

# Detect OS. Sets VS_OS to "macos" | "linux" | "unsupported".
platform_detect_os() {
  case "$(uname -s)" in
    Darwin) VS_OS=macos ;;
    Linux)  VS_OS=linux ;;
    *)      VS_OS=unsupported ;;
  esac
  export VS_OS
}

# Normalized paths (XDG on Linux, ~/Library on macOS):

platform_log_dir() {
  case "${VS_OS:-}" in
    macos) echo "$HOME/Library/Logs" ;;
    linux) echo "$HOME/.local/state/vault-sync/log" ;;
    *)     echo "$HOME/.local/state/vault-sync/log" ;;
  esac
}

platform_cache_dir() {
  case "${VS_OS:-}" in
    macos) echo "$HOME/Library/Caches/vault-sync" ;;
    linux) echo "$HOME/.cache/vault-sync" ;;
    *)     echo "$HOME/.cache/vault-sync" ;;
  esac
}

platform_share_dir() {
  case "${VS_OS:-}" in
    macos) echo "$HOME/Library/Application Support/vault-sync" ;;
    linux) echo "$HOME/.local/share/vault-sync" ;;
    *)     echo "$HOME/.local/share/vault-sync" ;;
  esac
}

platform_rclone_config_dir() {
  echo "$HOME/.config/rclone"
}

# Stat wrappers (BSD -f vs GNU -c):

platform_stat_size() {
  # echo bytes
  case "${VS_OS:-}" in
    macos) stat -f%z "$1" 2>/dev/null || echo 0 ;;
    linux) stat -c%s "$1" 2>/dev/null || echo 0 ;;
    *)     stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null || echo 0 ;;
  esac
}

platform_stat_ctime() {
  # echo unix epoch
  case "${VS_OS:-}" in
    macos) stat -f%c "$1" 2>/dev/null || echo 0 ;;
    linux) stat -c%Z "$1" 2>/dev/null || echo 0 ;;
    *)     stat -c%Z "$1" 2>/dev/null || stat -f%c "$1" 2>/dev/null || echo 0 ;;
  esac
}

# Notification (graceful degrade):
#   macos: osascript display notification
#   linux: notify-send if available, else log only
#   headless: no-op (return 0)
platform_notify() {
  _title="$1"
  _msg="$2"
  case "${VS_OS:-}" in
    macos)
      osascript -e "display notification \"$_msg\" with title \"$_title\"" 2>/dev/null || true
      ;;
    linux)
      if command -v notify-send >/dev/null 2>&1; then
        notify-send "$_title" "$_msg" 2>/dev/null || true
      fi
      # Headless Linux: no-op, return 0
      ;;
    *) ;;
  esac
}

# Scheduler abstraction:

platform_scheduler() {
  # echo: launchd | systemd | none
  case "${VS_OS:-}" in
    macos)
      if command -v launchctl >/dev/null 2>&1; then
        echo "launchd"
      else
        echo "none"
      fi
      ;;
    linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user >/dev/null 2>&1; then
        echo "systemd"
      else
        echo "none"
      fi
      ;;
    *) echo "none" ;;
  esac
}

platform_job_status() {
  # Returns JSON: {"enabled": bool, "running": bool, "last_exit": int}
  _name="$1"
  _enabled=false
  _running=false
  _last_exit=-1

  case "${VS_OS:-}" in
    macos)
      # launchd: check via launchctl print
      if launchctl print "gui/$(id -u)/${_name}" >/dev/null 2>&1; then
        _enabled=true
        _running=true  # launchd prints exit status if job ran
        _last_exit=0   # simplified; full parsing is complex
      fi
      ;;
    linux)
      # systemd --user
      if _is_enabled="$(systemctl --user is-enabled "${_name}.timer" 2>/dev/null)"; then
        if [ "$_is_enabled" = "enabled" ]; then
          _enabled=true
        fi
      fi
      if _is_active="$(systemctl --user is-active "${_name}.timer" 2>/dev/null)"; then
        if [ "$_is_active" = "active" ]; then
          _running=true
        fi
      fi
      _last_exit=0  # simplified
      ;;
  esac

  printf '{"enabled": %s, "running": %s, "last_exit": %d}\n' "$_enabled" "$_running" "$_last_exit"
}

# Feature prerequisite check:
# exit 1 with message if not available
platform_require() {
  _feature="$1"
  case "$_feature" in
    rclone)
      if ! command -v rclone >/dev/null 2>&1; then
        echo "FATAL: rclone not found in PATH" >&2
        return 1
      fi
      ;;
    git)
      if ! command -v git >/dev/null 2>&1; then
        echo "FATAL: git not found in PATH" >&2
        return 1
      fi
      ;;
    linux)
      if [ "${VS_OS:-}" != "linux" ]; then
        echo "FATAL: this operation requires Linux" >&2
        return 1
      fi
      ;;
    macos)
      if [ "${VS_OS:-}" != "macos" ]; then
        echo "FATAL: this operation requires macOS" >&2
        return 1
      fi
      ;;
    *)
      echo "FATAL: unknown prerequisite: $_feature" >&2
      return 1
      ;;
  esac
}
