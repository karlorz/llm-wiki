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
rc=0
output=$(HOME="$TEMP_HOME" "${CLI[@]}" init \
  --target "$VAULT" \
  --domain "E2E Test" \
  --taxonomy "research,concept,tool" \
  --lang en 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "init succeeds"
assert_json_contains "$output" "ok" "true" "init returns ok"

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
rc=0
output=$("${CLI[@]}" lint "$VAULT" 2>/dev/null) || rc=$?
assert_exit 23 "$rc" "lint detects errors"
assert_json_contains "$output" "ok" "true"                "lint returns ok envelope"
assert_json_contains "$output" "data.summary.errors" "2"  "lint reports 2 errors"

# ==== 4. links ==============================================================
printf "\n--- links ---\n"
rc=0
output=$("${CLI[@]}" links "$VAULT" 2>/dev/null) || rc=$?
assert_exit 16 "$rc" "links detects broken wikilinks"
assert_json_contains "$output" "data.broken.0.slug" "nonexistent-page" "links reports broken slug"

# ==== 5. orphans ============================================================
printf "\n--- orphans ---\n"
rc=0
output=$("${CLI[@]}" orphans "$VAULT" 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "orphans exits 0 (warnings only)"
# Orphan list order is non-deterministic; check that the array contains orphan-entity
orphans_ok=$(printf '%s' "$output" | python3 -c "
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
rc=0
output=$("${CLI[@]}" tag-audit "$VAULT" 2>/dev/null) || rc=$?
assert_exit 17 "$rc" "tag-audit detects violations"
assert_json_contains "$output" "data.violations.0.tag" "not-in-taxonomy" "tag-audit reports bad tag"

# ==== 7. index-check ========================================================
printf "\n--- index-check ---\n"
rc=0
output=$("${CLI[@]}" index-check "$VAULT" 2>/dev/null) || rc=$?
assert_exit 18 "$rc" "index-check detects missing entries"
assert_json_contains "$output" "ok" "true" "index-check returns ok envelope"

# ==== 8. stale ==============================================================
printf "\n--- stale ---\n"
rc=0
output=$("${CLI[@]}" stale "$VAULT" --days 90 2>/dev/null) || rc=$?
assert_exit 19 "$rc" "stale detects stale pages"

# ==== 9. pagesize ===========================================================
printf "\n--- pagesize ---\n"
rc=0
output=$("${CLI[@]}" pagesize "$VAULT" --lines 200 2>/dev/null) || rc=$?
assert_exit 20 "$rc" "pagesize detects oversized pages"

# ==== 10. log-rotate (check) ================================================
printf "\n--- log-rotate check ---\n"
rc=0
output=$("${CLI[@]}" log-rotate "$VAULT" --threshold 500 2>/dev/null) || rc=$?
assert_exit 21 "$rc" "log-rotate detects rotation need"

# ==== 11. log-rotate (apply) ================================================
printf "\n--- log-rotate apply ---\n"
rc=0
output=$("${CLI[@]}" log-rotate "$VAULT" --threshold 500 --apply 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "log-rotate apply succeeds"
assert_file_exists "$VAULT/log-2026.md" "rotated log file created"

# ==== 12. path ==============================================================
printf "\n--- path ---\n"
rc=0
output=$("${CLI[@]}" path --vault "$VAULT" --explain 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "path succeeds"
assert_json_contains "$output" "data.source" "flag"    "path source is flag"
assert_json_contains "$output" "data.path"   "$VAULT"  "path resolves to vault"

# ==== 13. lang ==============================================================
printf "\n--- lang ---\n"
rc=0
output=$("${CLI[@]}" lang --lang chinese-traditional --explain 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "lang succeeds"
assert_json_contains "$output" "data.canonical" "zh-Hant" "lang resolves alias"
assert_json_contains "$output" "data.source"    "flag"     "lang source is flag"

# ==== 14. install --dry-run =================================================
printf "\n--- install dry-run ---\n"
rc=0
output=$("${CLI[@]}" install --dry-run \
  --skills-root "$REPO_ROOT/packages/skills" 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "install dry-run succeeds"
assert_json_contains "$output" "ok" "true" "install dry-run returns ok"

# ==== 15. install (full) ====================================================
printf "\n--- install full ---\n"
INSTALL_TARGET=$(mktemp -d)
rc=0
output=$("${CLI[@]}" install \
  --target "$INSTALL_TARGET" \
  --skills-root "$REPO_ROOT/packages/skills" 2>/dev/null) || rc=$?
assert_exit 0 "$rc" "install succeeds"
assert_json_contains "$output" "ok" "true" "install returns ok"
assert_file_exists "$INSTALL_TARGET/wiki-manifest.json" "install writes manifest"

# ==== Summary ===============================================================
summary
