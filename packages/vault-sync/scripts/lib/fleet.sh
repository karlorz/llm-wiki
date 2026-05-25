#!/bin/sh
# fleet.sh — Fleet manifest parsing for vault-sync.
#
# Reads fleet.yaml from the vault and provides role enforcement.
# Uses yq if available, awk fallback for the limited schema.

# Populate VS_FLEET_* env from YAML.
# Uses yq if available, awk fallback otherwise.
fleet_load() {
  _fleet_file=""
  if command -v skillwiki >/dev/null 2>&1; then
    _vault_path=$(skillwiki path 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['path'])" 2>/dev/null) || true
    if [ -n "${_vault_path:-}" ]; then
      _fleet_file="$_vault_path/projects/llm-wiki/architecture/fleet.yaml"
    fi
  fi

  # Fallback: guess from WIKI_DIR
  if [ -z "${_fleet_file:-}" ] || [ ! -f "$_fleet_file" ]; then
    _wiki_dir="${WIKI_DIR:-$HOME/wiki}"
    _fleet_file="$_wiki_dir/projects/llm-wiki/architecture/fleet.yaml"
  fi

  if [ ! -f "$_fleet_file" ]; then
    VS_FLEET_LOADED=false
    export VS_FLEET_LOADED
    return 0
  fi

  VS_FLEET_FILE="$_fleet_file"
  VS_FLEET_LOADED=true
  export VS_FLEET_FILE VS_FLEET_LOADED
}

# Echo: hostname of current snapshotter, or "" if none.
fleet_get_snapshotter() {
  if [ "${VS_FLEET_LOADED:-false}" != "true" ]; then
    fleet_load
  fi
  if [ "${VS_FLEET_LOADED:-false}" != "true" ]; then
    echo ""
    return 0
  fi

  if command -v yq >/dev/null 2>&1; then
    yq '.hosts | to_entries[] | select(.value.role == "snapshotter") | .key' "$VS_FLEET_FILE" 2>/dev/null
  else
    # awk fallback: find the host with role: snapshotter
    awk '/^  [a-z0-9_-]+:/{host=$1; gsub(/:/,"",host)} /role: snapshotter/{print host; exit}' "$VS_FLEET_FILE" 2>/dev/null
  fi
}

# Exit 0 if host is marked protected: true, 1 otherwise.
fleet_is_protected() {
  _host="$1"
  if [ "${VS_FLEET_LOADED:-false}" != "true" ]; then
    fleet_load
  fi
  if [ "${VS_FLEET_LOADED:-false}" != "true" ]; then
    return 1
  fi

  if command -v yq >/dev/null 2>&1; then
    _prot=$(yq ".hosts.$_host.protected // false" "$VS_FLEET_FILE" 2>/dev/null)
    [ "$_prot" = "true" ]
  else
    # awk fallback: find protected: true under the host key
    awk -v h="$_host" '
      $0 ~ "^  " h ":" { in_host=1; next }
      /^  [a-z]/ { in_host=0 }
      in_host && /protected: true/ { found=1; exit }
      END { exit (found ? 0 : 1) }
    ' "$VS_FLEET_FILE" 2>/dev/null
  fi
}

# Exit 0 if install is safe, non-zero with reason if not.
fleet_validate_install() {
  _host="$1"
  _role="$2"
  _override="${3:-false}"

  if [ "${VS_FLEET_LOADED:-false}" != "true" ]; then
    fleet_load
  fi

  # If role is not snapshotter, install is always safe
  if [ "$_role" != "snapshotter" ]; then
    return 0
  fi

  # Check if a snapshotter already exists
  _current=$(fleet_get_snapshotter)
  if [ -n "$_current" ] && [ "$_current" != "$_host" ]; then
    if [ "$_override" != "true" ]; then
      echo "FATAL: host '$_current' is already the snapshotter. Use --override-snapshotter to force." >&2
      return 1
    fi
    echo "WARNING: overriding snapshotter from '$_current' to '$_host'" >&2
  fi

  return 0
}
