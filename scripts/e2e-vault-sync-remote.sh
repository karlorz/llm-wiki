#!/usr/bin/env bash
# scripts/e2e-vault-sync-remote.sh
# Remote e2e test for vault-sync on a host selected by HOST_ENV.
#
# Safety contract:
#   - READONLY_VERIFY=true branch is strictly read-only and only invokes
#     vault-sync-status with --read-only.
#   - Full branch (READONLY_VERIFY=false) runs install/uninstall on dev hosts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"
source "$SCRIPT_DIR/lib/host-env.sh"

HOST_ENV="${HOST_ENV:-$SCRIPT_DIR/hosts/sg02.env}"
host_env_load "$HOST_ENV"

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
REMOTE_E2E_ROOT="/tmp/vault-sync-e2e-$$-$(date +%s)"
REMOTE_VAULT_SYNC_ROOT="${REMOTE_VAULT_SYNC_ROOT:-$REMOTE_E2E_ROOT/vault-sync}"

STATUS_JSON_OK() {
  printf '%s' "$1" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d.get("checks"), list); assert d.get("summary", {}).get("error") == 0'
}

printf "\n=== Vault Sync Remote E2E (%s on %s) ===\n" "$HOST_CLASS" "$SSH_HOST"
printf "Role      : %s\n" "$HOST_ROLE"
printf "Mode      : %s\n" "$([ "$READONLY_VERIFY" = "true" ] && echo "read-only" || echo "full cycle")"
printf "Host env  : %s\n" "$HOST_ENV"

printf "\n--- SSH connectivity ---\n"
run_cli ssh "$SSH_TARGET" "echo ok"
assert_exit 0 "$RUN_RC" "ssh connectivity to $SSH_TARGET"

if [ "$READONLY_VERIFY" = "true" ]; then
  printf "\n--- Read-only status (sg01-safe path) ---\n"

  # Read-only discovery: find existing status.sh without writing remote state.
  run_cli ssh "$SSH_TARGET" "find \"$HOME\" \"$VAULT_PATH\" -type f -path '*/vault-sync-status/status.sh' 2>/dev/null | head -n 1"
  assert_exit 0 "$RUN_RC" "discover vault-sync status.sh path"
  STATUS_REMOTE_PATH="$RUN_OUTPUT"

  if [ -z "$STATUS_REMOTE_PATH" ]; then
    FAIL=$((FAIL + 1)); printf "  ✗ no remote vault-sync-status/status.sh found\n"
  else
    PASS=$((PASS + 1)); printf "  ✓ discovered status script: %s\n" "$STATUS_REMOTE_PATH"

    run_cli ssh "$SSH_TARGET" "bash '$STATUS_REMOTE_PATH' --read-only --json"
    assert_exit 0 "$RUN_RC" "vault-sync-status --read-only --json succeeds"
    if [ "$RUN_RC" -eq 0 ] && STATUS_JSON_OK "$RUN_OUTPUT"; then
      PASS=$((PASS + 1)); printf "  ✓ status JSON valid and summary.error=0\n"
    else
      FAIL=$((FAIL + 1)); printf "  ✗ status JSON invalid or summary.error!=0\n"
    fi
  fi

  printf "\n"
  summary
  exit 0
fi

printf "\n--- Full-cycle prep ---\n"
require_install_allowed || { printf "\n"; summary; exit 0; }

run_cli ssh "$SSH_TARGET" "rm -rf '$REMOTE_E2E_ROOT' && mkdir -p '$REMOTE_E2E_ROOT'"
assert_exit 0 "$RUN_RC" "create remote e2e workspace"

run_cli scp -r "$REPO_ROOT/packages/vault-sync" "$SSH_TARGET:$REMOTE_E2E_ROOT/"
assert_exit 0 "$RUN_RC" "scp vault-sync plugin bundle"

printf "\n--- Install (real) ---\n"
run_cli ssh "$SSH_TARGET" "bash '$REMOTE_VAULT_SYNC_ROOT/skills/vault-sync-install/install.sh' --execute --role '$HOST_ROLE'"
assert_exit 0 "$RUN_RC" "vault-sync-install --execute succeeds"

# Idempotency: second install should also succeed.
run_cli ssh "$SSH_TARGET" "bash '$REMOTE_VAULT_SYNC_ROOT/skills/vault-sync-install/install.sh' --execute --role '$HOST_ROLE'"
assert_exit 0 "$RUN_RC" "second vault-sync-install --execute succeeds"

if [ "$SCHEDULER" = "systemd" ]; then
  run_cli ssh "$SSH_TARGET" "systemctl --user is-active wiki-push.timer"
  assert_exit 0 "$RUN_RC" "wiki-push.timer is active"
fi

printf "\n--- Status after install ---\n"
run_cli ssh "$SSH_TARGET" "bash '$REMOTE_VAULT_SYNC_ROOT/skills/vault-sync-status/status.sh' --read-only --json"
assert_exit 0 "$RUN_RC" "vault-sync-status --read-only --json succeeds"
if [ "$RUN_RC" -eq 0 ] && STATUS_JSON_OK "$RUN_OUTPUT"; then
  PASS=$((PASS + 1)); printf "  ✓ status JSON valid and summary.error=0\n"
else
  FAIL=$((FAIL + 1)); printf "  ✗ status JSON invalid or summary.error!=0\n"
fi

printf "\n--- Uninstall (real) ---\n"
if require_destructive_allowed; then
  run_cli ssh "$SSH_TARGET" "bash '$REMOTE_VAULT_SYNC_ROOT/skills/vault-sync-uninstall/uninstall.sh'"
  assert_exit 0 "$RUN_RC" "vault-sync-uninstall succeeds"

  # Idempotency: second uninstall should be a clean no-op.
  run_cli ssh "$SSH_TARGET" "bash '$REMOTE_VAULT_SYNC_ROOT/skills/vault-sync-uninstall/uninstall.sh'"
  assert_exit 0 "$RUN_RC" "second vault-sync-uninstall succeeds"

  if [ "$SCHEDULER" = "systemd" ]; then
    run_cli ssh "$SSH_TARGET" "systemctl --user is-active wiki-push.timer >/dev/null 2>&1"
    if [ "$RUN_RC" -ne 0 ]; then
      PASS=$((PASS + 1)); printf "  ✓ wiki-push.timer inactive after uninstall\n"
    else
      FAIL=$((FAIL + 1)); printf "  ✗ wiki-push.timer still active after uninstall\n"
    fi

    run_cli ssh "$SSH_TARGET" "test ! -f ~/.config/systemd/user/wiki-push.timer && test ! -f ~/.config/systemd/user/wiki-fetch.timer"
    assert_exit 0 "$RUN_RC" "systemd timer unit files removed"
  fi
else
  printf "  SKIP: uninstall gated by DESTRUCTIVE_ALLOWED=%s\n" "$DESTRUCTIVE_ALLOWED"
fi

printf "\n--- Remote cleanup ---\n"
run_cli ssh "$SSH_TARGET" "rm -rf '$REMOTE_E2E_ROOT'"
assert_exit 0 "$RUN_RC" "remove remote e2e workspace"

printf "\n"
summary
