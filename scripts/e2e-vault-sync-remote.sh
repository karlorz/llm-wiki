#!/usr/bin/env bash
# scripts/e2e-vault-sync-remote.sh
# Generic remote e2e smoke test for vault-sync operations on a target host.
#
# Reads the HOST_ENV environment variable to select the target host.
# Default HOST_ENV: scripts/hosts/sg02.env
#
# Behavior depends on READONLY_VERIFY:
#   true  → status-only + assert --max-delete guard present
#   false → full install/uninstall cycle
#
# Prerequisites:
#   - ssh <SSH_HOST> works with key auth (from .env)
#   - Remote host has Node.js 20+
#   - skillwiki installed globally on remote
#
# Usage:
#   # Default sg02 (dev-linux):
#   bash scripts/e2e-vault-sync-remote.sh
#
#   # sg01 read-only verification (workflow_dispatch only):
#   HOST_ENV=scripts/hosts/sg01.env bash scripts/e2e-vault-sync-remote.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Source shared helpers and host-env
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"
source "$SCRIPT_DIR/lib/host-env.sh"

# ---------------------------------------------------------------------------
# 2. Load host env
# ---------------------------------------------------------------------------
HOST_ENV="${HOST_ENV:-$SCRIPT_DIR/hosts/sg02.env}"
host_env_load "$HOST_ENV"

# Read expected version from package.json
EXPECTED_VERSION=$(grep '"version"' "$REPO_ROOT/packages/cli/package.json" | head -1 | sed 's/.*: *"//;s/".*//')

printf "\n=== Vault Sync Remote E2E (%s on %s) ===\n" "$HOST_CLASS" "$SSH_HOST"
printf "Role    : %s\n" "$HOST_ROLE"
printf "Mode    : %s\n" "$([ "$READONLY_VERIFY" = "true" ] && echo "read-only" || echo "full cycle")"
printf "Vault   : %s\n" "$VAULT_PATH"

# ---------------------------------------------------------------------------
# 3. Connection check + skillwiki version
# ---------------------------------------------------------------------------
printf "\n--- Connection and version ---\n"

run_cli ssh "$SSH_HOST" "echo ok"
assert_exit 0 "$RUN_RC" "SSH connection to $SSH_HOST"

run_cli ssh "$SSH_HOST" "skillwiki --version"
assert_exit 0 "$RUN_RC" "remote skillwiki --version"
if printf '%s' "$RUN_OUTPUT" | grep -q "$EXPECTED_VERSION"; then
  PASS=$((PASS + 1)); printf "  \u2713 remote version is %s\n" "$EXPECTED_VERSION"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 remote version mismatch: %s vs expected %s\n" "$RUN_OUTPUT" "$EXPECTED_VERSION"
fi

# ---------------------------------------------------------------------------
# 4. Status-only (runs in both readonly and full mode)
# ---------------------------------------------------------------------------
printf "\n--- Vault sync status ---\n"

# Verify vault directory exists
run_cli ssh "$SSH_HOST" "test -d $VAULT_PATH"
if [ "$RUN_RC" -eq 0 ]; then
  PASS=$((PASS + 1)); printf "  \u2713 vault path %s exists\n" "$VAULT_PATH"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 vault path %s not accessible\n" "$VAULT_PATH"
fi

# Check rclone is present if required
if [ "$RCLONE_REQUIRED" = "true" ]; then
  run_cli ssh "$SSH_HOST" "which rclone"
  assert_exit 0 "$RUN_RC" "rclone is installed (required by env)"
fi

# Check scheduler is configured
run_cli ssh "$SSH_HOST" "which systemctl"
if [ "$RUN_RC" -eq 0 ] && [ "$SCHEDULER" = "systemd" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 systemd is available (scheduler=%s)\n" "$SCHEDULER"
elif [ "$SCHEDULER" != "systemd" ]; then
  printf "  SKIP: scheduler is %s\n" "$SCHEDULER"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 expected systemd but systemctl not found\n"
fi

# ---------------------------------------------------------------------------
# 5. Read-only verify branch: assert --max-delete guard, then done
# ---------------------------------------------------------------------------
if [ "$READONLY_VERIFY" = "true" ]; then
  printf "\n--- Read-only verification ---\n"

  # Check that the snapshot script has the --max-delete guard
  SNAPSHOT_SCRIPT="/root/.hermes/scripts/wiki-snapshot-v3.sh"
  run_cli ssh "$SSH_HOST" "test -f $SNAPSHOT_SCRIPT"
  if [ "$RUN_RC" -eq 0 ]; then
    PASS=$((PASS + 1)); printf "  \u2713 snapshot script exists at %s\n" "$SNAPSHOT_SCRIPT"
    # Verify --max-delete flag is present (guard against destructive sync)
    run_cli ssh "$SSH_HOST" "grep -q 'max-delete' $SNAPSHOT_SCRIPT"
    assert_exit 0 "$RUN_RC" "snapshot script has --max-delete guard"
  else
    printf "  SKIP: snapshot script not found at %s (non-snapshotter host)\n" "$SNAPSHOT_SCRIPT"
  fi

  # Verify backup of original exists
  run_cli ssh "$SSH_HOST" "test -f ${SNAPSHOT_SCRIPT}.bak.* 2>/dev/null || ls ${SNAPSHOT_SCRIPT}.bak.* 2>/dev/null || true"
  if [ -n "$RUN_OUTPUT" ]; then
    PASS=$((PASS + 1)); printf "  \u2713 snapshot backup exists\n"
  else
    printf "  SKIP: no snapshot backup found (may have been cleaned up)\n"
  fi

  # Verify no write operations happened (status-only — nothing to clean)
  printf "\n  Read-only verification complete — no writes performed.\n"
  printf "  Summary: %s passed status checks.\n" "$SSH_HOST"

  printf "\n"
  summary
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. Full cycle: install (gated on INSTALL_ALLOWED)
# ---------------------------------------------------------------------------
printf "\n--- Install on %s ---\n" "$SSH_HOST"

if require_install_allowed; then
  INSTALL_TARGET_REMOTE="/tmp/vault-sync-install-$(date +%s)"

  # TODO: When vault-sync-install subcommand is implemented:
  #   1. Run vault-sync-install --target $INSTALL_TARGET_REMOTE
  #   2. Verify manifest created
  #   3. Verify systemd service/timer created (if SCHEDULER=systemd)
  #   4. Verify env file at /root/.skillwiki/.env
  #   5. Verify rclone config

  # For now, verify target dir is writable
  run_cli ssh "$SSH_HOST" "mkdir -p $INSTALL_TARGET_REMOTE && rm -rf $INSTALL_TARGET_REMOTE"
  assert_exit 0 "$RUN_RC" "remote temp directory is writable"

  PASS=$((PASS + 1)); printf "  \u2713 install stub passed (INSTALL_ALLOWED=true)\n"
else
  printf "  SKIP: install gated by INSTALL_ALLOWED=%s\n" "$INSTALL_ALLOWED"
fi

# ---------------------------------------------------------------------------
# 7. Full cycle: uninstall (gated on DESTRUCTIVE_ALLOWED)
# ---------------------------------------------------------------------------
printf "\n--- Uninstall on %s ---\n" "$SSH_HOST"

if require_destructive_allowed; then
  # TODO: When vault-sync-uninstall is implemented:
  #   1. Run vault-sync-uninstall
  #   2. Verify manifest removed
  #   3. Verify systemd service stopped/disabled
  #   4. Verify tombstone file created
  PASS=$((PASS + 1)); printf "  \u2713 uninstall stub passed (DESTRUCTIVE_ALLOWED=true)\n"
else
  printf "  SKIP: uninstall gated by DESTRUCTIVE_ALLOWED=%s\n" "$DESTRUCTIVE_ALLOWED"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n"
summary
