#!/usr/bin/env bash
# scripts/e2e-vault-sync-local.sh
# macOS e2e for vault-sync installer/uninstaller scripts.
#
# Safety strategy:
#   The installer uses fixed launchd labels (com.karlchow.wiki-push/fetch).
#   On the user's dev host these collide with the production launchd jobs.
#   Default mode is DRY-RUN ONLY (no state changes, never touches launchctl).
#   Set LOCAL_LIFECYCLE=true to enable full install/uninstall lifecycle —
#   intended for fresh CI runners (GitHub Actions macOS) where there are no
#   pre-existing wiki-push/wiki-fetch services to collide with.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"
source "$SCRIPT_DIR/lib/host-env.sh"

HOST_ENV="${HOST_ENV:-$SCRIPT_DIR/hosts/macos-dev.env}"
host_env_load "$HOST_ENV"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "FATAL: local vault-sync e2e is macOS-only"
  exit 1
fi
if [ "${SCHEDULER:-}" != "launchd" ]; then
  echo "FATAL: expected SCHEDULER=launchd, got ${SCHEDULER:-unset}"
  exit 1
fi

INSTALL_SH="$REPO_ROOT/packages/vault-sync/skills/vault-sync-install/install.sh"
STATUS_SH="$REPO_ROOT/packages/vault-sync/skills/vault-sync-status/status.sh"
UNINSTALL_SH="$REPO_ROOT/packages/vault-sync/skills/vault-sync-uninstall/uninstall.sh"

for script in "$INSTALL_SH" "$STATUS_SH" "$UNINSTALL_SH"; do
  if [ ! -x "$script" ]; then
    echo "FATAL: script is missing or not executable: $script"
    exit 1
  fi
done

LIFECYCLE="${LOCAL_LIFECYCLE:-false}"

printf "\n=== Vault Sync Local E2E (%s) ===\n" "$HOST_CLASS"
printf "Host       : localhost\n"
printf "Vault      : %s\n" "$VAULT_PATH"
printf "Host env   : %s\n" "$HOST_ENV"
printf "Mode       : %s\n" "$([ "$LIFECYCLE" = "true" ] && echo "FULL LIFECYCLE (touches launchctl)" || echo "DRY-RUN ONLY (safe for dev host)")"

# 1) Dry-run installer sanity (always runs)
printf "\n--- Dry-run install ---\n"
run_cli bash "$INSTALL_SH" --dry-run --role "$HOST_ROLE"
assert_exit 0 "$RUN_RC" "vault-sync-install --dry-run succeeds"

# 2) status.sh JSON + zero errors (always runs — read-only)
printf "\n--- Status check (read-only) ---\n"
run_cli bash "$STATUS_SH" --read-only --json
assert_exit 0 "$RUN_RC" "vault-sync-status --read-only --json succeeds"
if [ "$RUN_RC" -eq 0 ]; then
  if printf '%s' "$RUN_OUTPUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert isinstance(d.get("checks"), list)'; then
    PASS=$((PASS + 1)); printf "  ✓ status JSON valid\n"
  else
    FAIL=$((FAIL + 1)); printf "  ✗ status JSON invalid\n"
  fi
fi

# 3) Dry-run uninstall (always runs)
printf "\n--- Dry-run uninstall ---\n"
run_cli bash "$UNINSTALL_SH" --dry-run
assert_exit 0 "$RUN_RC" "vault-sync-uninstall --dry-run succeeds"

# 4) FULL LIFECYCLE — only when LOCAL_LIFECYCLE=true (fresh CI runner)
if [ "$LIFECYCLE" = "true" ]; then
  printf "\n--- Full lifecycle (LOCAL_LIFECYCLE=true) ---\n"
  printf "    WARNING: this touches launchctl. Intended for fresh CI runners only.\n"

  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  PUSH_LABEL="com.karlchow.wiki-push"
  FETCH_LABEL="com.karlchow.wiki-fetch"

  # Refuse to run on a host with the labels already loaded — collision guard.
  if launchctl print "gui/$UID/$PUSH_LABEL" >/dev/null 2>&1 || \
     launchctl print "gui/$UID/$FETCH_LABEL" >/dev/null 2>&1; then
    echo "FATAL: $PUSH_LABEL or $FETCH_LABEL already loaded — refusing full lifecycle to protect production services."
    echo "       Run on a fresh host, or unload these labels manually before re-running with LOCAL_LIFECYCLE=true."
    exit 1
  fi

  run_cli bash "$INSTALL_SH" --execute --role "$HOST_ROLE"
  assert_exit 0 "$RUN_RC" "real install succeeds"

  # Idempotency
  run_cli bash "$INSTALL_SH" --execute --role "$HOST_ROLE"
  assert_exit 0 "$RUN_RC" "second install succeeds (idempotent)"

  run_cli launchctl print "gui/$UID/$PUSH_LABEL"
  assert_exit 0 "$RUN_RC" "launchctl print push job"
  run_cli launchctl print "gui/$UID/$FETCH_LABEL"
  assert_exit 0 "$RUN_RC" "launchctl print fetch job"

  if require_destructive_allowed; then
    run_cli bash "$UNINSTALL_SH"
    assert_exit 0 "$RUN_RC" "real uninstall succeeds"
  fi

  # Tombstones present
  for tomb in "$LAUNCH_AGENTS_DIR/${PUSH_LABEL}.plist.RETIRED.md" "$LAUNCH_AGENTS_DIR/${FETCH_LABEL}.plist.RETIRED.md"; do
    [ -f "$tomb" ] && { PASS=$((PASS + 1)); printf "  ✓ tombstone %s\n" "$tomb"; } || \
      { FAIL=$((FAIL + 1)); printf "  ✗ tombstone missing: %s\n" "$tomb"; }
    # cleanup so CI runner stays clean
    rm -f "$tomb"
  done

  # Jobs gone
  run_cli launchctl print "gui/$UID/$PUSH_LABEL"
  if [ "$RUN_RC" -ne 0 ]; then
    PASS=$((PASS + 1)); printf "  ✓ push job absent after uninstall\n"
  else
    FAIL=$((FAIL + 1)); printf "  ✗ push job still present\n"
  fi
else
  printf "\n--- Full lifecycle SKIPPED ---\n"
  printf "    Set LOCAL_LIFECYCLE=true to enable (fresh CI runner only).\n"
fi

printf "\n"
summary
