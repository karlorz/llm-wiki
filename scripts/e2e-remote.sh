#!/usr/bin/env bash
# scripts/e2e-remote.sh
# End-to-end smoke tests for the skillwiki CLI on a remote Debian host (sg01).
#
# Prerequisites:
#   - ssh sg01 works with key auth
#   - Remote host has Node.js 20+
#   - skillwiki@beta installed globally (npm install -g skillwiki@beta)
#
# Usage:
#   ./scripts/e2e-remote.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# 1. Source shared helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"

# ---------------------------------------------------------------------------
# 2. Setup
# ---------------------------------------------------------------------------
SSH_HOST="sg01"
REMOTE_CLI="skillwiki"
VAULT_NAME="skillwiki-e2e-$(date +%s)"
VAULT_REMOTE="/tmp/$VAULT_NAME"
INSTALL_TARGET="/tmp/skillwiki-install-$(date +%s)"

printf "\n=== Remote E2E (sg01) ===\n"
printf "Vault : %s\n" "$VAULT_REMOTE"
printf "Target: %s\n" "$INSTALL_TARGET"

# ---------------------------------------------------------------------------
# Cleanup trap — always restore Hermes .env and remove temp dirs
# ---------------------------------------------------------------------------
cleanup() {
  ssh "$SSH_HOST" "mv ~/.hermes/.env.e2e-backup ~/.hermes/.env 2>/dev/null || rm -f ~/.hermes/.env" 2>/dev/null || true
  ssh "$SSH_HOST" "rm -rf $VAULT_REMOTE $INSTALL_TARGET" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 3. Install / verify skillwiki on remote
# ---------------------------------------------------------------------------
printf "\n--- Verify skillwiki on %s ---\n" "$SSH_HOST"

run_cli ssh "$SSH_HOST" "$REMOTE_CLI --version"
assert_exit 0 "$RUN_RC" "skillwiki --version on remote"
printf "  version: %s\n" "$RUN_OUTPUT"

# ---------------------------------------------------------------------------
# 4. Prepare Hermes compat environment on remote
# ---------------------------------------------------------------------------
printf "\n--- Prepare Hermes compat ---\n"

# Backup existing ~/.hermes/.env if present
ssh "$SSH_HOST" "cp ~/.hermes/.env ~/.hermes/.env.e2e-backup 2>/dev/null || true"

# Write test Hermes .env pointing at our temp vault
ssh "$SSH_HOST" "echo 'WIKI_PATH=$VAULT_REMOTE' > ~/.hermes/.env"

# Ensure no ~/.skillwiki/.env exists (so skillwiki-dotenv has no WIKI_PATH)
ssh "$SSH_HOST" "rm -f ~/.skillwiki/.env"

printf "  Hermes .env: WIKI_PATH=%s\n" "$VAULT_REMOTE"

# ---------------------------------------------------------------------------
# 5. Init with Hermes fallback (no --target)
# ---------------------------------------------------------------------------
printf "\n--- Init with Hermes fallback ---\n"

run_cli ssh "$SSH_HOST" "$REMOTE_CLI init --domain 'E2E Remote Test' --taxonomy 'research,concept,tool' --lang en"
assert_exit 0 "$RUN_RC" "remote init succeeds"
assert_json_contains "$RUN_OUTPUT" "data.imported_from_hermes" "true" "init detects Hermes fallback"

# ---------------------------------------------------------------------------
# 6. Verify vault dirs created on remote
# ---------------------------------------------------------------------------
printf "\n--- Verify vault structure ---\n"

for dir in raw/articles entities concepts meta; do
  if ssh "$SSH_HOST" "test -d $VAULT_REMOTE/$dir" 2>/dev/null; then
    PASS=$((PASS + 1))
    printf "  \u2713 vault has %s/\n" "$dir"
  else
    FAIL=$((FAIL + 1))
    printf "  \u2717 vault missing %s/\n" "$dir"
  fi
done

if ssh "$SSH_HOST" "test -f $VAULT_REMOTE/SCHEMA.md" 2>/dev/null; then
  PASS=$((PASS + 1))
  printf "  \u2713 vault has SCHEMA.md\n"
else
  FAIL=$((FAIL + 1))
  printf "  \u2717 vault missing SCHEMA.md\n"
fi

# ---------------------------------------------------------------------------
# 7. Restore ~/.hermes/.env before proceeding
# ---------------------------------------------------------------------------
ssh "$SSH_HOST" "mv ~/.hermes/.env.e2e-backup ~/.hermes/.env 2>/dev/null || rm -f ~/.hermes/.env" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 8. Seed vault with fixture files on remote
# ---------------------------------------------------------------------------
printf "\n--- Seed vault on remote ---\n"

# Transfer e2e-common.sh to remote and call seed_vault directly.
# This avoids duplicating the seed logic (~110 lines).
REMOTE_COMMON="/tmp/sw-common-$(date +%s).sh"
scp "$SCRIPT_DIR/e2e-common.sh" "$SSH_HOST:$REMOTE_COMMON" >/dev/null

rc=0
ssh "$SSH_HOST" "source $REMOTE_COMMON && seed_vault $VAULT_REMOTE && rm -f $REMOTE_COMMON" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1))
  printf "  \u2713 seed_vault on remote\n"
else
  FAIL=$((FAIL + 1))
  printf "  \u2717 seed_vault on remote failed\n"
fi

# ---------------------------------------------------------------------------
# 9. Run lint suite on remote
# ---------------------------------------------------------------------------
printf "\n--- Remote lint suite ---\n"

# lint → 23 (has errors)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI lint $VAULT_REMOTE"
assert_exit 23 "$RUN_RC" "remote lint (errors)"

# links → 16 (broken wikilinks)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI links $VAULT_REMOTE"
assert_exit 16 "$RUN_RC" "remote links (broken)"

# orphans → 0 (orphans is a warning, lint aggregates as warning; command succeeds)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI orphans $VAULT_REMOTE"
assert_exit 0 "$RUN_RC" "remote orphans (ok)"

# tag-audit → 17 (tag not in taxonomy)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI tag-audit $VAULT_REMOTE"
assert_exit 17 "$RUN_RC" "remote tag-audit (bad tag)"

# index-check → 18 (index incomplete)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI index-check $VAULT_REMOTE"
assert_exit 18 "$RUN_RC" "remote index-check (incomplete)"

# stale → 19 (stale page)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI stale $VAULT_REMOTE"
assert_exit 19 "$RUN_RC" "remote stale (stale page)"

# pagesize → 20 (page too large)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI pagesize $VAULT_REMOTE"
assert_exit 20 "$RUN_RC" "remote pagesize (oversized)"

# log-rotate → 21 (log rotate needed)
run_cli ssh "$SSH_HOST" "$REMOTE_CLI log-rotate $VAULT_REMOTE"
assert_exit 21 "$RUN_RC" "remote log-rotate (rotation needed)"

# ---------------------------------------------------------------------------
# 10. path --explain
# ---------------------------------------------------------------------------
printf "\n--- Remote path --explain ---\n"

run_cli ssh "$SSH_HOST" "$REMOTE_CLI path --vault $VAULT_REMOTE --explain"
assert_exit 0 "$RUN_RC" "remote path succeeds"
assert_json_contains "$RUN_OUTPUT" "data.source" "flag" "remote path source is flag"

# ---------------------------------------------------------------------------
# 11. lang --explain
# ---------------------------------------------------------------------------
printf "\n--- Remote lang --explain ---\n"

run_cli ssh "$SSH_HOST" "$REMOTE_CLI lang --lang chinese-traditional --explain"
assert_exit 0 "$RUN_RC" "remote lang succeeds"
assert_json_contains "$RUN_OUTPUT" "data.canonical" "zh-Hant" "remote lang resolves alias"

# ---------------------------------------------------------------------------
# 12. install on remote
# ---------------------------------------------------------------------------
printf "\n--- Remote install ---\n"

run_cli ssh "$SSH_HOST" "$REMOTE_CLI install --target $INSTALL_TARGET"
assert_exit 0 "$RUN_RC" "remote install succeeds"

# Verify manifest was written
if ssh "$SSH_HOST" "test -f $INSTALL_TARGET/wiki-manifest.json" 2>/dev/null; then
  PASS=$((PASS + 1))
  printf "  \u2713 remote manifest exists ($INSTALL_TARGET/wiki-manifest.json)\n"
else
  FAIL=$((FAIL + 1))
  printf "  \u2717 remote manifest missing\n"
fi

# ---------------------------------------------------------------------------
# 13. Summary
# ---------------------------------------------------------------------------
printf "\n"
summary
