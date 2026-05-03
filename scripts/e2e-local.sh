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

# ==== Summary ===============================================================
summary
