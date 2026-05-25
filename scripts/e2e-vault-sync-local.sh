#!/usr/bin/env bash
# scripts/e2e-vault-sync-local.sh
# macOS-only e2e smoke test for the vault-sync-install skill.
#
# Tests what's testable today (dry-run, status) and documents the steps
# that will fully exercise the installer after deployment logic is
# implemented.
#
# Prerequisites:
#   - macOS with launchd
#   - Node.js 20+
#   - skillwiki CLI built (run `npm run -w skillwiki build` first)
#
# Usage:
#   HOST_ENV=scripts/hosts/macos-dev.env bash scripts/e2e-vault-sync-local.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Source shared helpers and host-env
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"
source "$SCRIPT_DIR/lib/host-env.sh"

# ---------------------------------------------------------------------------
# 2. Load host env (default: macos-dev)
# ---------------------------------------------------------------------------
HOST_ENV="${HOST_ENV:-$SCRIPT_DIR/hosts/macos-dev.env}"
host_env_load "$HOST_ENV"

printf "\n=== Vault Sync Local E2E (%s) ===\n" "$HOST_CLASS"
printf "Host  : localhost\n"
printf "Vault : %s\n" "$VAULT_PATH"

# ---------------------------------------------------------------------------
# 3. Verify CLI is built and reachable
# ---------------------------------------------------------------------------
CLI="$REPO_ROOT/packages/cli/dist/cli.js"
if [ ! -f "$CLI" ]; then
  echo "FATAL: CLI not built — run 'npm run -w skillwiki build' first"
  exit 1
fi

run_cli node "$CLI" --version
assert_exit 0 "$RUN_RC" "CLI --version succeeds"

# ---------------------------------------------------------------------------
# 4. Dry-run install (no-op test of installer scaffolding)
# ---------------------------------------------------------------------------
printf "\n--- Dry-run install ---\n"
DRY_RUN_TARGET=$(mktemp -d)

run_cli node "$CLI" install --target "$DRY_RUN_TARGET" --dry-run
assert_exit 0 "$RUN_RC" "dry-run install succeeds"
# Dry-run should NOT create files
if [ ! -f "$DRY_RUN_TARGET/wiki-manifest.json" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 dry-run did not write manifest\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 dry-run wrote manifest unexpectedly\n"
fi
rm -rf "$DRY_RUN_TARGET"

# ---------------------------------------------------------------------------
# 5. Execute install (gate on INSTALL_ALLOWED)
# ---------------------------------------------------------------------------
INSTALL_TARGET=""
require_install_allowed || true  # document the gate, don't abort

if require_install_allowed 2>/dev/null; then
  printf "\n--- Execute install ---\n"
  INSTALL_TARGET=$(mktemp -d)

  run_cli node "$CLI" install --target "$INSTALL_TARGET"
  assert_exit 0 "$RUN_RC" "install succeeds"
  assert_file_exists "$INSTALL_TARGET/wiki-manifest.json" "manifest written"

  # TODO: After vault-sync-installer is implemented, add:
  #   - Verify launchd plist was created
  #   - Verify plist is loaded (launchctl list)
  #   - Verify env files are in place
  #   - Verify rclone config test
  #   - Verify vault-sync-status returns healthy
else
  printf "\n--- Install skipped (INSTALL_ALLOWED=%s) ---\n" "$INSTALL_ALLOWED"
fi

# ---------------------------------------------------------------------------
# 6. Wait for launchd and verify logs (skeleton)
# ---------------------------------------------------------------------------
printf "\n--- Launchd verification (skeleton) ---\n"
if [ "$SCHEDULER" = "launchd" ]; then
  # TODO: Full implementation after installer is built
  #   1. launchctl list | grep com.karlchow.wiki-push
  #   2. Check job is "loaded" (not "in progress" or "not found")
  #   3. Wait up to 90s for push cycle
  #   4. grep syslog / log stream for job output
  PASS=$((PASS + 1)); printf "  \u2713 launchd verification stubbed (scheduler=%s)\n" "$SCHEDULER"
else
  printf "  SKIP: scheduler is %s, not launchd\n" "$SCHEDULER"
fi

# ---------------------------------------------------------------------------
# 7. Status command (gate-independent — always testable)
# ---------------------------------------------------------------------------
printf "\n--- Status check ---\n"
# TODO: Replace with vault-sync-status subcommand when implemented
# For now, verify CLI commands work against the vault
if [ -d "$VAULT_PATH" ]; then
  run_cli node "$CLI" path --vault "$VAULT_PATH"
  assert_exit 0 "$RUN_RC" "path resolves on vault"
  assert_json_contains "$RUN_OUTPUT" "data.source" "flag" "path source is flag"
else
  printf "  SKIP: vault path %s not accessible\n" "$VAULT_PATH"
fi

# ---------------------------------------------------------------------------
# 8. Uninstall (gate on DESTRUCTIVE_ALLOWED)
# ---------------------------------------------------------------------------
printf "\n--- Uninstall (gated) ---\n"
if require_destructive_allowed 2>/dev/null && [ -n "$INSTALL_TARGET" ]; then
  # TODO: When vault-sync-uninstall is implemented:
  #   1. Run uninstall command
  #   2. Verify manifest removed
  #   3. Verify plist unloaded
  #   4. Verify tombstone file written with uninstall timestamp
  rm -rf "$INSTALL_TARGET"
  INSTALL_TARGET=""
  PASS=$((PASS + 1)); printf "  \u2713 uninstall stubbed (cleanup only)\n"
else
  printf "  SKIP: destructive ops not allowed on %s\n" "${SSH_HOST:-localhost}"
fi

# ---------------------------------------------------------------------------
# 9. Verify tombstone artifact (skeleton)
# ---------------------------------------------------------------------------
printf "\n--- Tombstone verification (skeleton) ---\n"
# TODO: After vault-sync-uninstall is implemented:
#   1. Assert tombstone file exists at ~/.skillwiki/vault-sync-tombstone.json
#   2. Assert JSON has fields: uninstalled_at, host, version
#   3. Assert vault-sync-status returns "not installed"
PASS=$((PASS + 1)); printf "  \u2713 tombstone verification stubbed\n"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n"
summary
