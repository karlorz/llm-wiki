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

# macOS LaunchAgent plist validation. Callers inspect the non-empty
# PLATFORM_LAUNCHD_PLIST_REASON when this returns non-zero. The generated
# vault-sync units are XML plists, but use plutil to canonicalize a valid
# binary plist before applying the same structural checks. The validated first
# argument is exported for installer-only executable preflight warnings.
PLATFORM_LAUNCHD_PLIST_REASON=""
PLATFORM_LAUNCHD_PLIST_PROGRAM=""

platform_launchd_plist_validate() {
  _platform_expected_label="${1:-}"
  _platform_plist="${2:-}"
  _platform_xml=""
  _platform_fields=""
  _platform_document_kind=""
  _platform_label_kind=""
  _platform_program_kind=""
  _platform_actual_label=""
  _platform_program=""
  PLATFORM_LAUNCHD_PLIST_REASON=""
  PLATFORM_LAUNCHD_PLIST_PROGRAM=""

  if [ -z "$_platform_expected_label" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="expected Label is empty"
    return 1
  fi
  if [ -z "$_platform_plist" ] || [ ! -f "$_platform_plist" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="plist file missing: ${_platform_plist:-unknown}"
    return 1
  fi
  if [ ! -r "$_platform_plist" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="plist file is not readable: $_platform_plist"
    return 1
  fi

  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "$_platform_plist" >/dev/null 2>&1; then
      PLATFORM_LAUNCHD_PLIST_REASON="plutil -lint failed"
      return 1
    fi
    if ! _platform_xml="$(plutil -convert xml1 -o - "$_platform_plist" 2>/dev/null)"; then
      PLATFORM_LAUNCHD_PLIST_REASON="plutil could not render plist as XML"
      return 1
    fi
  else
    # Keep status useful on non-macOS CI hosts that lack plutil. This fallback
    # intentionally supports structural XML only; macOS uses plutil above for
    # syntactic validation and binary-plist conversion.
    _platform_xml="$(cat "$_platform_plist")"
  fi

  # Parse the root plist dictionary structurally rather than searching for
  # text. In particular, a Label-like string inside ProgramArguments must not
  # satisfy Label validation, and ProgramArguments[0] must actually be a
  # non-empty <string>, not merely a scalar which plutil can render as raw.
  _platform_fields="$(
    printf '%s\n' "$_platform_xml" | awk '
      BEGIN {
        label_kind = "missing"
        program_kind = "missing"
      }
      function trim(value) {
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        return value
      }
      function string_value(value) {
        sub(/^[[:space:]]*<string>/, "", value)
        sub(/<\/string>[[:space:]]*$/, "", value)
        return value
      }
      function invalid() {
        invalid_token = 1
      }
      function open_container(kind) {
        if (!plist_seen || plist_closed) {
          invalid()
          return
        }
        if (container_depth == 0) {
          if (kind != "dict" || root_dict_seen) {
            invalid()
            return
          }
          root_dict_seen = 1
        }
        container_depth++
        container_stack[container_depth] = kind
        if (kind == "dict") dict_depth++
      }
      function close_container(kind) {
        if (container_depth == 0 || container_stack[container_depth] != kind) {
          invalid()
          return
        }
        if (kind == "dict") {
          if (dict_depth == 1) root_dict_closed = 1
          dict_depth--
        }
        delete container_stack[container_depth]
        container_depth--
      }
      function process(line) {
        line = trim(line)
        if (line == "") return
        # Comments are ignorable XML; skip content until the closing -->.
        # The shipped templates carry a multi-line comment, so a single-line
        # /^<!--.*-->$/ match is not enough.
        if (in_comment) {
          if (line ~ /-->$/) in_comment = 0
          return
        }
        if (line ~ /^<!--/) {
          if (line !~ /-->$/) in_comment = 1
          return
        }
        if (line ~ /^<\?xml[[:space:]][^>]*\?>$/) {
          if (plist_seen || xml_declaration_seen) invalid()
          xml_declaration_seen = 1
          return
        }
        if (line ~ /^<!DOCTYPE[[:space:]].*>$/) {
          if (plist_seen || doctype_seen) invalid()
          doctype_seen = 1
          return
        }
        if (line ~ /^<plist([[:space:]][^>]*)?>$/) {
          if (plist_seen || plist_closed || container_depth != 0 || root_dict_seen) {
            invalid()
          } else {
            plist_seen = 1
          }
          return
        }
        if (line == "</plist>") {
          if (!plist_seen || plist_closed || !root_dict_closed || container_depth != 0) {
            invalid()
          } else {
            plist_closed = 1
          }
          return
        }

        if (label_wait) {
          if (line ~ /^<string>[^<]*<\/string>$/) {
            label_value = string_value(line)
            label_kind = "string"
            label_wait = 0
            return
          }
          label_kind = "not-string"
          label_wait = 0
        }

        if (program_wait_array) {
          if (line == "<array>") {
            program_wait_array = 0
            program_wait_first = 1
            open_container("array")
            return
          }
          program_kind = "not-array"
          program_wait_array = 0
        }

        if (program_wait_first) {
          if (line ~ /^<string>[^<]*<\/string>$/) {
            program_value = string_value(line)
            program_kind = (program_value == "" ? "empty" : "string")
            program_wait_first = 0
            return
          }
          program_kind = (line == "</array>" ? "missing" : "not-string")
          program_wait_first = 0
        }

        if (line == "<dict>") {
          open_container("dict")
          return
        }
        if (line == "</dict>") {
          close_container("dict")
          return
        }
        if (line == "<array>") {
          open_container("array")
          return
        }
        if (line == "</array>") {
          close_container("array")
          return
        }
        if (line ~ /^<key>Label<\/key>$/ && dict_depth == 1 && container_depth == 1 && label_kind == "missing") {
          label_wait = 1
          return
        }
        if (line ~ /^<key>ProgramArguments<\/key>$/ && dict_depth == 1 && container_depth == 1 && program_kind == "missing") {
          program_wait_array = 1
          return
        }
        if (line ~ /^<key>[^<]*<\/key>$/ ||
            line ~ /^<string>[^<]*<\/string>$/ ||
            line ~ /^<integer>[^<]*<\/integer>$/ ||
            line ~ /^<real>[^<]*<\/real>$/ ||
            line ~ /^<date>[^<]*<\/date>$/ ||
            line ~ /^<data>[^<]*<\/data>$/ ||
            line == "<true/>" || line == "<false/>") {
          if (!plist_seen || plist_closed || container_depth == 0) invalid()
          return
        }
        invalid()
      }
      {
        content = $0
        gsub(/></, ">\n<", content)
        count = split(content, chunks, "\n")
        for (chunk_index = 1; chunk_index <= count; chunk_index++) process(chunks[chunk_index])
      }
      END {
        if (label_wait && label_kind == "missing") label_kind = "not-string"
        if (program_wait_array) program_kind = "not-array"
        if (program_wait_first) program_kind = "missing"
        document_kind = (plist_seen && plist_closed && root_dict_seen && root_dict_closed &&
                         dict_depth == 0 && container_depth == 0 && !invalid_token && !in_comment ? "valid" : "invalid")
        printf "DOCUMENT_KIND=%s\n", document_kind
        printf "LABEL_KIND=%s\n", label_kind
        printf "LABEL_VALUE=%s\n", label_value
        printf "PROGRAM_KIND=%s\n", program_kind
        printf "PROGRAM_VALUE=%s\n", program_value
      }
    '
  )"
  _platform_document_kind="$(printf '%s\n' "$_platform_fields" | awk 'sub(/^DOCUMENT_KIND=/, "") { print; exit }')"
  _platform_label_kind="$(printf '%s\n' "$_platform_fields" | awk 'sub(/^LABEL_KIND=/, "") { print; exit }')"
  _platform_actual_label="$(printf '%s\n' "$_platform_fields" | awk 'sub(/^LABEL_VALUE=/, "") { print; exit }')"
  _platform_program_kind="$(printf '%s\n' "$_platform_fields" | awk 'sub(/^PROGRAM_KIND=/, "") { print; exit }')"
  _platform_program="$(printf '%s\n' "$_platform_fields" | awk 'sub(/^PROGRAM_VALUE=/, "") { print; exit }')"

  if [ "$_platform_document_kind" != "valid" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="plist XML structure is invalid"
    return 1
  fi
  if [ "$_platform_label_kind" != "string" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="Label missing or is not a string"
    return 1
  fi

  if [ "$_platform_actual_label" != "$_platform_expected_label" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="Label is '${_platform_actual_label:-missing}', expected '$_platform_expected_label'"
    return 1
  fi
  case "$_platform_program_kind" in
    missing)
      PLATFORM_LAUNCHD_PLIST_REASON="ProgramArguments[0] missing"
      return 1
      ;;
    empty)
      PLATFORM_LAUNCHD_PLIST_REASON="ProgramArguments[0] is empty"
      return 1
      ;;
    string)
      ;;
    *)
      PLATFORM_LAUNCHD_PLIST_REASON="ProgramArguments[0] must be a string"
      return 1
      ;;
  esac
  if [ -z "$_platform_program" ]; then
    PLATFORM_LAUNCHD_PLIST_REASON="ProgramArguments[0] missing"
    return 1
  fi
  PLATFORM_LAUNCHD_PLIST_PROGRAM="$_platform_program"
  return 0
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
