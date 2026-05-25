# scripts/lib/host-env.sh
# Per-host .env loader with validation guards for vault-sync E2E tests.
# Source this file — do NOT execute it directly.
#
# Usage:
#   source "$(dirname "$0")/lib/host-env.sh"
#   host_env_load "scripts/hosts/sg02.env"
#   require_install_allowed || exit 0   # skip if not allowed
#   require_destructive_allowed || exit 0

# ---------------------------------------------------------------------------
# host_env_load <env_file>
#
# Sources the given .env file and validates that all invariant rules hold:
#   - If READONLY_VERIFY=true then INSTALL_ALLOWED must be false AND
#     DESTRUCTIVE_ALLOWED must be false.
# ---------------------------------------------------------------------------
host_env_load() {
  local env_file="$1"

  [ -f "$env_file" ] || { echo "FATAL: $env_file not found"; exit 1; }

  # shellcheck disable=SC1090
  . "$env_file"

  # Validation: READONLY_VERIFY=true forces both install and destructive off.
  if [ "$READONLY_VERIFY" = "true" ]; then
    if [ "${INSTALL_ALLOWED:-}" != "false" ]; then
      echo "FATAL: READONLY_VERIFY=true requires INSTALL_ALLOWED=false (got ${INSTALL_ALLOWED:-unset})"
      exit 1
    fi
    if [ "${DESTRUCTIVE_ALLOWED:-}" != "false" ]; then
      echo "FATAL: READONLY_VERIFY=true requires DESTRUCTIVE_ALLOWED=false (got ${DESTRUCTIVE_ALLOWED:-unset})"
      exit 1
    fi
  fi

  # Warn if SSH_HOST is unset after loading
  if [ -z "${SSH_HOST:-}" ]; then
    echo "WARNING: SSH_HOST is not set in $env_file"
  fi
}

# ---------------------------------------------------------------------------
# require_install_allowed
#
# Guard that returns 0 if INSTALL_ALLOWED=true, otherwise prints a SKIP
# message and returns 1. Use in e2e scripts to gate install/test steps:
#   require_install_allowed || exit 0
# ---------------------------------------------------------------------------
require_install_allowed() {
  if [ "${INSTALL_ALLOWED:-false}" = "true" ]; then
    return 0
  fi
  echo "SKIP: INSTALL_ALLOWED=false on ${SSH_HOST:-localhost}"
  return 1
}

# ---------------------------------------------------------------------------
# require_destructive_allowed
#
# Guard that returns 0 if DESTRUCTIVE_ALLOWED=true, otherwise prints a SKIP
# message and returns 1. Use to gate uninstall, service restart, or script
# swap steps:
#   require_destructive_allowed || exit 0
# ---------------------------------------------------------------------------
require_destructive_allowed() {
  if [ "${DESTRUCTIVE_ALLOWED:-false}" = "true" ]; then
    return 0
  fi
  echo "SKIP: DESTRUCTIVE_ALLOWED=false on ${SSH_HOST:-localhost}"
  return 1
}
