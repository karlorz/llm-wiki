#!/usr/bin/env bash
set -euo pipefail

# e2e-local.sh — macOS local smoke test for the skillwiki CLI.
# Sources e2e-common.sh for shared helpers and seed_vault.
#
# Usage:  ./scripts/e2e-local.sh
# Expects Node.js and python3 on PATH.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_ROOT/scripts/e2e-common.sh"

printf "=== skillwiki e2e-local smoke test ===\n\n"

# ---- Setup -----------------------------------------------------------------
VAULT=$(mktemp -d)
TEMP_HOME=$(mktemp -d)
REAL_HOME="${HOME:-}"
INSTALL_TARGET=""

cleanup() {
  rm -rf "$VAULT" "$TEMP_HOME"
  [ -n "$INSTALL_TARGET" ] && rm -rf "$INSTALL_TARGET"
  [ -n "${CRYPTO_VAULT:-}" ] && rm -rf "$CRYPTO_VAULT"
  HOME="$REAL_HOME"
}
trap cleanup EXIT

# ---- Build -----------------------------------------------------------------
printf "%s\n" "--- Building CLI ---"
npm run -w packages/cli build --silent

# ---- CLI binary ------------------------------------------------------------
CLI=(node "$REPO_ROOT/packages/cli/dist/cli.js")

# ==== 1. init ===============================================================
printf "\n--- init ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" init \
  --target "$VAULT" \
  --domain "E2E Test" \
  --taxonomy "research,concept,tool" \
  --lang en
assert_exit 0 "$RUN_RC" "init succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "init returns ok"

for dir in raw/articles raw/papers raw/transcripts raw/assets \
           entities concepts comparisons queries meta projects; do
  assert_file_exists "$VAULT/$dir" "init created $dir"
done
assert_file_exists "$VAULT/SCHEMA.md"               "init created SCHEMA.md"
assert_file_exists "$VAULT/index.md"                "init created index.md"
assert_file_exists "$VAULT/log.md"                  "init created log.md"
assert_file_exists "$TEMP_HOME/.skillwiki/.env"     "init wrote .env"

# ==== 2. Seed vault =========================================================
seed_vault "$VAULT"

# ==== 3. lint ===============================================================
printf "\n--- lint ---\n"
run_cli "${CLI[@]}" lint "$VAULT"
assert_exit 23 "$RUN_RC" "lint detects errors"
assert_json_contains "$RUN_OUTPUT" "ok" "true"                "lint returns ok envelope"
assert_json_contains "$RUN_OUTPUT" "data.summary.errors" "2"  "lint reports 2 errors"

# ==== 4. links ==============================================================
printf "\n--- links ---\n"
run_cli "${CLI[@]}" links "$VAULT"
assert_exit 16 "$RUN_RC" "links detects broken wikilinks"
assert_json_contains "$RUN_OUTPUT" "data.broken.0.slug" "nonexistent-page" "links reports broken slug"

# ==== 5. orphans ============================================================
printf "\n--- orphans ---\n"
run_cli "${CLI[@]}" orphans "$VAULT"
assert_exit 0 "$RUN_RC" "orphans exits 0 (warnings only)"
# Orphan list order is non-deterministic; check that the array contains orphan-entity
orphans_ok=$(printf '%s' "$RUN_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
slugs = [o.split('/')[-1].replace('.md','') for o in data.get('data',{}).get('orphans',[])]
print('yes' if 'orphan-entity' in slugs else 'no')
" 2>/dev/null)
if [ "$orphans_ok" = "yes" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 orphans detects orphan-entity\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 orphans did not detect orphan-entity\n"
fi

# ==== 6. tag-audit ==========================================================
printf "\n--- tag-audit ---\n"
run_cli "${CLI[@]}" tag-audit "$VAULT"
assert_exit 17 "$RUN_RC" "tag-audit detects violations"
assert_json_contains "$RUN_OUTPUT" "data.violations.0.tag" "not-in-taxonomy" "tag-audit reports bad tag"

# ==== 7. index-check ========================================================
printf "\n--- index-check ---\n"
run_cli "${CLI[@]}" index-check "$VAULT"
assert_exit 18 "$RUN_RC" "index-check detects missing entries"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "index-check returns ok envelope"

# ==== 8. stale ==============================================================
printf "\n--- stale ---\n"
run_cli "${CLI[@]}" stale "$VAULT" --days 90
assert_exit 19 "$RUN_RC" "stale detects stale pages"

# ==== 9. pagesize ===========================================================
printf "\n--- pagesize ---\n"
run_cli "${CLI[@]}" pagesize "$VAULT" --lines 200
assert_exit 20 "$RUN_RC" "pagesize detects oversized pages"

# ==== 10. log-rotate (check) ================================================
printf "\n--- log-rotate check ---\n"
run_cli "${CLI[@]}" log-rotate "$VAULT" --threshold 500
assert_exit 21 "$RUN_RC" "log-rotate detects rotation need"

# ==== 11. log-rotate (apply) ================================================
printf "\n--- log-rotate apply ---\n"
run_cli "${CLI[@]}" log-rotate "$VAULT" --threshold 500 --apply
assert_exit 0 "$RUN_RC" "log-rotate apply succeeds"
assert_file_exists "$VAULT/log-2026.md" "rotated log file created"

# ==== 12. path ==============================================================
printf "\n--- path ---\n"
run_cli "${CLI[@]}" path --vault "$VAULT" --explain
assert_exit 0 "$RUN_RC" "path succeeds"
assert_json_contains "$RUN_OUTPUT" "data.source" "flag"    "path source is flag"
assert_json_contains "$RUN_OUTPUT" "data.path"   "$VAULT"  "path resolves to vault"

# ==== 13. lang ==============================================================
printf "\n--- lang ---\n"
run_cli "${CLI[@]}" lang --lang chinese-traditional --explain
assert_exit 0 "$RUN_RC" "lang succeeds"
assert_json_contains "$RUN_OUTPUT" "data.canonical" "zh-Hant" "lang resolves alias"
assert_json_contains "$RUN_OUTPUT" "data.source"    "flag"     "lang source is flag"

# ==== 14. install --dry-run =================================================
printf "\n--- install dry-run ---\n"
run_cli "${CLI[@]}" install --dry-run \
  --skills-root "$REPO_ROOT/packages/skills"
assert_exit 0 "$RUN_RC" "install dry-run succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "install dry-run returns ok"

# ==== 15. install (full) ====================================================
printf "\n--- install full ---\n"
INSTALL_TARGET=$(mktemp -d)
run_cli "${CLI[@]}" install \
  --target "$INSTALL_TARGET" \
  --skills-root "$REPO_ROOT/packages/skills"
assert_exit 0 "$RUN_RC" "install succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "install returns ok"
assert_file_exists "$INSTALL_TARGET/wiki-manifest.json" "install writes manifest"

# ==== 16. config path ========================================================
printf "\n--- config path ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config path
assert_exit 0 "$RUN_RC" "config path succeeds"
assert_json_contains "$RUN_OUTPUT" "data.path" "$TEMP_HOME/.skillwiki/.env" "config path returns correct path"
assert_json_contains "$RUN_OUTPUT" "data.exists" "true" "config path reports exists"

# ==== 17. config set =========================================================
printf "\n--- config set ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config set WIKI_LANG ja
assert_exit 0 "$RUN_RC" "config set succeeds"
assert_json_contains "$RUN_OUTPUT" "data.key"     "WIKI_LANG" "config set returns key"
assert_json_contains "$RUN_OUTPUT" "data.value"   "ja"        "config set returns value"
assert_json_contains "$RUN_OUTPUT" "data.written" "true"      "config set confirms written"

# ==== 18. config get =========================================================
printf "\n--- config get ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config get WIKI_LANG
assert_exit 0 "$RUN_RC" "config get succeeds"
assert_json_contains "$RUN_OUTPUT" "data.key"   "WIKI_LANG" "config get returns key"
assert_json_contains "$RUN_OUTPUT" "data.value" "ja"        "config get returns value"

# ==== 19. config get (unset key) =============================================
printf "\n--- config get unset key ---\n"
# Use a fresh HOME with no config to test unset key
FRESH_HOME=$(mktemp -d)
run_cli env HOME="$FRESH_HOME" "${CLI[@]}" config get WIKI_LANG
assert_exit 0 "$RUN_RC" "config get unset key exits 0"
assert_json_contains "$RUN_OUTPUT" "data.value" "" "config get returns empty for unset"
rm -rf "$FRESH_HOME"

# ==== 20. config list ========================================================
printf "\n--- config list ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config list
assert_exit 0 "$RUN_RC" "config list succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "config list returns ok"

# ==== 21. config set invalid key =============================================
printf "\n--- config set invalid key ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config set BOGUS value
assert_exit 26 "$RUN_RC" "config set rejects invalid key (exit 26)"
assert_json_contains "$RUN_OUTPUT" "ok" "false" "config set invalid returns error"
assert_json_contains "$RUN_OUTPUT" "error" "INVALID_CONFIG_KEY" "config set invalid returns error code"

# ==== 22. config get invalid key =============================================
printf "\n--- config get invalid key ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config get BOGUS
assert_exit 26 "$RUN_RC" "config get rejects invalid key (exit 26)"

# ==== 23. config --human =====================================================
printf "\n--- config --human ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" --human config list
assert_exit 0 "$RUN_RC" "config list --human exit 0"
# --human should print KEY=VALUE lines, not JSON
if printf '%s' "$RUN_OUTPUT" | grep -q '"ok"'; then
  FAIL=$((FAIL + 1)); printf "  \u2717 config list --human produced JSON\n"
else
  PASS=$((PASS + 1)); printf "  \u2713 config list --human is not JSON\n"
fi

# ==== 24. config --human path ================================================
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" --human config path
assert_exit 0 "$RUN_RC" "config path --human exit 0"

# ==== 25. doctor (valid vault, warns from cli_on_path) ========================
printf "\n--- doctor (valid vault) ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" doctor
# Running via `node cli.js` triggers cli_on_path=warn, so exit is 28 not 0
assert_exit 28 "$RUN_RC" "doctor exits 28 (warn from dev-mode cli_on_path)"
assert_json_contains "$RUN_OUTPUT" "ok"                "true" "doctor returns ok"
assert_json_contains "$RUN_OUTPUT" "data.summary.error" "0"   "doctor reports 0 errors"

# Verify at least 9 checks
checks_count=$(printf '%s' "$RUN_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(len(data.get('data',{}).get('checks',[])))
" 2>/dev/null)
if [ "$checks_count" -ge 9 ]; then
  PASS=$((PASS + 1)); printf "  \u2713 doctor returns %s checks (>=9)\n" "$checks_count"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 doctor returned %s checks, expected >=9\n" "$checks_count"
fi

# ==== 26. doctor (errors from bad WIKI_PATH) =================================
printf "\n--- doctor (errors) ---\n"
ERR_HOME=$(mktemp -d)
mkdir -p "$ERR_HOME/.skillwiki"
printf 'WIKI_PATH=/no/such/path\n' > "$ERR_HOME/.skillwiki/.env"
run_cli env HOME="$ERR_HOME" "${CLI[@]}" doctor
assert_exit 29 "$RUN_RC" "doctor exits 29 (has errors)"
assert_json_contains "$RUN_OUTPUT" "data.summary.error" "2" "doctor reports 2 errors (wiki_path_exists + vault_structure)"
rm -rf "$ERR_HOME"

# ==== 27. doctor --human (exit code unchanged per N2) ========================
printf "\n--- doctor --human ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" --human doctor
assert_exit 28 "$RUN_RC" "doctor --human exit matches JSON exit (N2)"
if printf '%s' "$RUN_OUTPUT" | grep -q '"ok"'; then
  FAIL=$((FAIL + 1)); printf "  \u2717 doctor --human produced JSON\n"
else
  PASS=$((PASS + 1)); printf "  \u2713 doctor --human is not JSON\n"
fi
# Should contain summary line
if printf '%s' "$RUN_OUTPUT" | grep -q 'pass.*warn.*error'; then
  PASS=$((PASS + 1)); printf "  \u2713 doctor --human shows summary line\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 doctor --human missing summary line\n"
fi

# ==== 28. config set profile key =================================================
printf "\n--- config set wiki.finance.path ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config set WIKI_FINANCE_PATH /finance/vault
assert_exit 0 "$RUN_RC" "config set profile key succeeds"
assert_json_contains "$RUN_OUTPUT" "data.key" "WIKI_FINANCE_PATH" "config set returns profile key"

# ==== 29. config get profile key =================================================
printf "\n--- config get wiki.finance.path ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config get WIKI_FINANCE_PATH
assert_exit 0 "$RUN_RC" "config get profile key succeeds"
assert_json_contains "$RUN_OUTPUT" "data.value" "/finance/vault" "config get returns profile value"

# ==== 30. config set WIKI_DEFAULT ================================================
printf "\n--- config set WIKI_DEFAULT ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config set WIKI_DEFAULT finance
assert_exit 0 "$RUN_RC" "config set WIKI_DEFAULT succeeds"

# ==== 31. config list --profiles ================================================
printf "\n--- config list --profiles ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" config list --profiles
assert_exit 0 "$RUN_RC" "config list --profiles succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "config list --profiles returns ok"

# ==== 32. path --wiki resolves profile ===========================================
printf "\n--- path --wiki finance ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" path --wiki finance --explain
assert_exit 0 "$RUN_RC" "path --wiki finance succeeds"
assert_json_contains "$RUN_OUTPUT" "data.source" "wiki-profile" "path source is wiki-profile"
assert_json_contains "$RUN_OUTPUT" "data.path" "/finance/vault" "path resolves to finance vault"

# ==== 33. path --wiki unknown returns exit 35 ====================================
printf "\n--- path --wiki unknown ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" path --wiki nonexistent
assert_exit 35 "$RUN_RC" "path --wiki nonexistent returns exit 35"

# ==== 34. WIKI_DEFAULT selects active profile ====================================
printf "\n--- path (WIKI_DEFAULT=finance) ---\n"
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" path --explain
assert_exit 0 "$RUN_RC" "path with WIKI_DEFAULT succeeds"
assert_json_contains "$RUN_OUTPUT" "data.source" "wiki-default" "path source is wiki-default"
assert_json_contains "$RUN_OUTPUT" "data.path" "/finance/vault" "path resolves default profile"

# ==== 35. init --profile =========================================================
printf "\n--- init --profile crypto ---\n"
CRYPTO_VAULT=$(mktemp -d)
run_cli env HOME="$TEMP_HOME" "${CLI[@]}" init \
  --target "$CRYPTO_VAULT" \
  --domain "Crypto" \
  --taxonomy "research" \
  --lang en \
  --profile crypto
assert_exit 0 "$RUN_RC" "init --profile succeeds"
# Verify WIKI_CRYPTO_PATH was written
crypto_path=$(grep 'WIKI_CRYPTO_PATH' "$TEMP_HOME/.skillwiki/.env" | cut -d= -f2)
if [ "$crypto_path" = "$CRYPTO_VAULT" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 WIKI_CRYPTO_PATH written correctly\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 WIKI_CRYPTO_PATH not found or wrong\n"
fi

# ==== Summary ===============================================================
summary
