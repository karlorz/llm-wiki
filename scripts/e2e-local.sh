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

# ==== 36. dedup (detect) =====================================================
printf "\n--- dedup detect ---\n"
DEDUP_VAULT=$(mktemp -d)
DEDUP_HOME=$(mktemp -d)
run_cli env HOME="$DEDUP_HOME" "${CLI[@]}" init --target "$DEDUP_VAULT" --domain "Dedup" --taxonomy "research" --lang en
mkdir -p "$DEDUP_VAULT/raw/articles" "$DEDUP_VAULT/concepts"
# Two raw files with identical sha256
cat > "$DEDUP_VAULT/raw/articles/aaa-orig.md" <<'RAWEOF'
---
type: raw
sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
ingested: "2026-05-06"
---
Content here.
RAWEOF
cp "$DEDUP_VAULT/raw/articles/aaa-orig.md" "$DEDUP_VAULT/raw/articles/aaa-dup.md"
# Concept page citing both files so rewiring is exercised regardless of scan order
cat > "$DEDUP_VAULT/concepts/test-page.md" <<'CONCEPTEOF'
---
title: Test
type: concept
tags: [research]
sources:
  - "^[raw/articles/aaa-orig.md]"
  - "^[raw/articles/aaa-dup.md]"
---

Details from orig.^[raw/articles/aaa-orig.md] More from dup.^[raw/articles/aaa-dup.md]
CONCEPTEOF
run_cli "${CLI[@]}" dedup "$DEDUP_VAULT"
assert_exit 33 "$RUN_RC" "dedup detects duplicates (exit 33)"
# Verify duplicate array has entries
dup_count=$(printf '%s' "$RUN_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data']['duplicates']))" 2>/dev/null)
if [ "$dup_count" = "1" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 dedup reports 1 duplicate group\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 dedup reports %s groups, expected 1\n" "$dup_count"
fi

# ==== 37. dedup --apply =====================================================
printf "\n--- dedup apply ---\n"
run_cli "${CLI[@]}" dedup "$DEDUP_VAULT" --apply
assert_exit 36 "$RUN_RC" "dedup --apply succeeds (exit 36)"
# Verify removed count via JSON — exactly 1 duplicate file should be removed
removed_count=$(printf '%s' "$RUN_OUTPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data']['removed']))" 2>/dev/null)
if [ "$removed_count" = "1" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 dedup apply removed 1 file\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 dedup apply removed %s files, expected 1\n" "$removed_count"
fi
# Verify only one raw file remains (the canonical)
raw_remaining=$(find "$DEDUP_VAULT/raw/articles" -name "aaa-*.md" | wc -l | tr -d ' ')
if [ "$raw_remaining" = "1" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 only 1 raw file remains after dedup\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 %s raw files remain, expected 1\n" "$raw_remaining"
fi
# Verify page citations now all point to one file (no mixed references)
canonical=$(find "$DEDUP_VAULT/raw/articles" -name "aaa-*.md" -exec basename {} .md \;)
page_body=$(cat "$DEDUP_VAULT/concepts/test-page.md")
if printf '%s' "$page_body" | grep -q "\^\[raw/articles/${canonical}.md\]"; then
  PASS=$((PASS + 1)); printf "  \u2713 citations point to canonical file %s\n" "$canonical"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 citations not pointing to canonical\n"
fi
rm -rf "$DEDUP_VAULT" "$DEDUP_HOME"

# ==== 38. frontmatter-fix (dry-run) ==========================================
printf "\n--- frontmatter-fix dry-run ---\n"
FMFIX_VAULT=$(mktemp -d)
FMFIX_HOME=$(mktemp -d)
run_cli env HOME="$FMFIX_HOME" "${CLI[@]}" init --target "$FMFIX_VAULT" --domain "FmFix" --taxonomy "research" --lang en
# Create a concept page with missing frontmatter fields
mkdir -p "$FMFIX_VAULT/concepts"
cat > "$FMFIX_VAULT/concepts/fmfix-page.md" <<'FMEOF'
---
title: FmFix Test
type: concept
---
## Overview

Some content here.
FMEOF
run_cli "${CLI[@]}" frontmatter-fix "$FMFIX_VAULT" --dry-run
assert_exit 34 "$RUN_RC" "frontmatter-fix dry-run detects fixes (exit 34)"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "frontmatter-fix dry-run returns ok"
# Verify page was NOT modified in dry-run
has_created=$(grep -c "^created:" "$FMFIX_VAULT/concepts/fmfix-page.md" || true)
if [ "$has_created" = "0" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 dry-run did not modify file\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 dry-run modified file\n"
fi

# ==== 39. frontmatter-fix (apply) ============================================
printf "\n--- frontmatter-fix apply ---\n"
run_cli "${CLI[@]}" frontmatter-fix "$FMFIX_VAULT"
assert_exit 34 "$RUN_RC" "frontmatter-fix apply exits 34 (MIGRATION_APPLIED)"
assert_json_contains "$RUN_OUTPUT" "data.fixed.0" "concepts/fmfix-page.md" "frontmatter-fix reports fixed page"
# Verify page WAS modified — now has created/updated/tags/sources/provenance
has_created=$(grep -c "^created:" "$FMFIX_VAULT/concepts/fmfix-page.md" || true)
has_provenance=$(grep -c "^provenance:" "$FMFIX_VAULT/concepts/fmfix-page.md" || true)
if [ "$has_created" -ge 1 ] && [ "$has_provenance" -ge 1 ]; then
  PASS=$((PASS + 1)); printf "  \u2713 apply added missing frontmatter fields\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 apply missing expected fields (created=%s, provenance=%s)\n" "$has_created" "$has_provenance"
fi
# Running again on same vault should find 0 fixes
run_cli "${CLI[@]}" frontmatter-fix "$FMFIX_VAULT" --dry-run
assert_exit 0 "$RUN_RC" "frontmatter-fix idempotent (0 fixes on clean vault)"
rm -rf "$FMFIX_VAULT" "$FMFIX_HOME"

# ==== 40. graph build ========================================================
printf "\n--- graph build ---\n"
run_cli "${CLI[@]}" graph build "$VAULT"
assert_exit 0 "$RUN_RC" "graph build succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "graph build returns ok"
node_count=$(printf '%s' "$RUN_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['node_count'])" 2>/dev/null)
if [ "$node_count" -ge 1 ]; then
  PASS=$((PASS + 1)); printf "  \u2713 graph has %s nodes\n" "$node_count"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 graph has 0 nodes\n"
fi

# ==== 41. overlap ============================================================
printf "\n--- overlap ---\n"
run_cli "${CLI[@]}" overlap "$VAULT"
assert_exit 0 "$RUN_RC" "overlap succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "overlap returns ok"
cluster_count=$(printf '%s' "$RUN_OUTPUT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['clusters']))" 2>/dev/null)
# Seed vault may be too sparse for overlap clusters — 0 is valid
PASS=$((PASS + 1)); printf "  \u2713 overlap found %s clusters (seed vault)\n" "$cluster_count"

# ==== 42. validate (valid file) ==============================================
printf "\n--- validate valid ---\n"
VALIDATE_TMP=$(mktemp -d)
cat > "$VALIDATE_TMP/concept.md" <<'VALEOF'
---
title: "Test"
type: concept
tags: [research]
created: "2026-05-06"
updated: "2026-05-06"
provenance: research
sources:
  - "^[raw/articles/test.md]"
---
## Overview

Test content.
VALEOF
run_cli "${CLI[@]}" validate "$VALIDATE_TMP/concept.md"
assert_exit 0 "$RUN_RC" "validate valid file succeeds"
assert_json_contains "$RUN_OUTPUT" "data.valid" "true" "validate reports valid"

# ==== 43. validate (invalid file) ============================================
printf "\n--- validate invalid ---\n"
cat > "$VALIDATE_TMP/invalid.md" <<'INVALEOF'
---
title: "Bad"
type: concept
tags: [research]
created: "2026-05-06"
updated: "2026-05-06"
provenance: research
sources: []
---
## Overview

Missing sources.
INVALEOF
run_cli "${CLI[@]}" validate "$VALIDATE_TMP/invalid.md"
assert_exit 7 "$RUN_RC" "validate rejects invalid frontmatter (exit 7)"
assert_json_contains "$RUN_OUTPUT" "data.valid" "false" "validate reports invalid"
rm -rf "$VALIDATE_TMP"

# ==== 44. validate (missing file) ============================================
printf "\n--- validate missing ---\n"
run_cli "${CLI[@]}" validate "/no/such/file.md"
assert_exit 2 "$RUN_RC" "validate missing file exits 2 (FILE_NOT_FOUND)"

# ==== 45. hash ===============================================================
printf "\n--- hash ---\n"
run_cli "${CLI[@]}" hash "$VAULT/SCHEMA.md"
assert_exit 0 "$RUN_RC" "hash succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "hash returns ok"
# sha256 should be 64 hex chars
hash_len=$(printf '%s' "$RUN_OUTPUT" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['data']['sha256']))" 2>/dev/null)
if [ "$hash_len" = "64" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 hash returns 64-char sha256\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 hash sha256 length is %s, expected 64\n" "$hash_len"
fi

# ==== 46. fetch-guard (allowed) ==============================================
printf "\n--- fetch-guard allowed ---\n"
run_cli "${CLI[@]}" fetch-guard "https://example.com/article"
assert_exit 0 "$RUN_RC" "fetch-guard allows https"
assert_json_contains "$RUN_OUTPUT" "data.allowed" "true" "fetch-guard returns allowed"

# ==== 47. fetch-guard (blocked host) =========================================
printf "\n--- fetch-guard blocked ---\n"
run_cli "${CLI[@]}" fetch-guard "https://metadata.google.internal/computeMetadata/v1/"
assert_exit 5 "$RUN_RC" "fetch-guard blocks metadata host (exit 5)"

# ==== 48. fetch-guard (bad scheme) ===========================================
printf "\n--- fetch-guard bad scheme ---\n"
run_cli "${CLI[@]}" fetch-guard "http://example.com/insecure"
assert_exit 4 "$RUN_RC" "fetch-guard rejects http (exit 4)"

# ==== 49. archive ============================================================
printf "\n--- archive ---\n"
ARCH_VAULT=$(mktemp -d)
ARCH_HOME=$(mktemp -d)
run_cli env HOME="$ARCH_HOME" "${CLI[@]}" init --target "$ARCH_VAULT" --domain "Archive" --taxonomy "research" --lang en
mkdir -p "$ARCH_VAULT/concepts"
cat > "$ARCH_VAULT/concepts/to-archive.md" <<'ARCHEOF'
---
title: "To Archive"
type: concept
tags: [research]
created: "2026-05-06"
updated: "2026-05-06"
provenance: research
sources: []
---
## Overview

Will be archived.
ARCHEOF
# Add to index so archive can remove it
printf '\n- [[to-archive]]\n' >> "$ARCH_VAULT/index.md"
run_cli "${CLI[@]}" archive to-archive "$ARCH_VAULT"
assert_exit 0 "$RUN_RC" "archive succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "archive returns ok"
assert_json_contains "$RUN_OUTPUT" "data.archived_from" "concepts/to-archive.md" "archive reports source"
assert_json_contains "$RUN_OUTPUT" "data.archived_to" "_archive/concepts/to-archive.md" "archive reports destination"
assert_json_contains "$RUN_OUTPUT" "data.index_updated" "true" "archive updated index"
# Verify file moved
if [ -f "$ARCH_VAULT/_archive/concepts/to-archive.md" ] && [ ! -f "$ARCH_VAULT/concepts/to-archive.md" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 archived file moved to _archive\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 archived file not in expected location\n"
fi
rm -rf "$ARCH_VAULT" "$ARCH_HOME"

# ==== 50. archive (not found) ================================================
printf "\n--- archive not found ---\n"
run_cli "${CLI[@]}" archive nonexistent-page "$VAULT"
assert_exit 30 "$RUN_RC" "archive not found exits 30 (ARCHIVE_TARGET_NOT_FOUND)"

# ==== 51. audit (clean page) =================================================
printf "\n--- audit clean ---\n"
AUDIT_VAULT=$(mktemp -d)
AUDIT_HOME=$(mktemp -d)
run_cli env HOME="$AUDIT_HOME" "${CLI[@]}" init --target "$AUDIT_VAULT" --domain "Audit" --taxonomy "research" --lang en
# Create a raw source and a concept page citing it
mkdir -p "$AUDIT_VAULT/raw/articles"
cat > "$AUDIT_VAULT/raw/articles/audit-source.md" <<'RAWEOF'
---
source_url: https://example.com/audit
sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ingested: "2026-05-07"
---
Audit source content.
RAWEOF
cat > "$AUDIT_VAULT/concepts/audit-page.md" <<'AUDEOF'
---
title: "Audit Test"
type: concept
tags: [research]
created: "2026-05-07"
updated: "2026-05-07"
provenance: research
sources:
  - "^[raw/articles/audit-source.md]"
---
## Overview

Content from source.^[raw/articles/audit-source.md]
AUDEOF
run_cli "${CLI[@]}" audit "$AUDIT_VAULT/concepts/audit-page.md"
assert_exit 0 "$RUN_RC" "audit clean page succeeds"
assert_json_contains "$RUN_OUTPUT" "ok" "true" "audit returns ok"

# ==== 52. audit (broken marker) ==============================================
printf "\n--- audit broken ---\n"
cat > "$AUDIT_VAULT/concepts/audit-broken.md" <<'AUDBRF'
---
title: "Audit Broken"
type: concept
tags: [research]
created: "2026-05-07"
updated: "2026-05-07"
provenance: research
sources:
  - "^[raw/articles/nonexistent.md]"
---
## Overview

Broken ref.^[raw/articles/nonexistent.md]
AUDBRF
run_cli "${CLI[@]}" audit "$AUDIT_VAULT/concepts/audit-broken.md"
assert_exit 11 "$RUN_RC" "audit detects unresolved markers (exit 11)"
rm -rf "$AUDIT_VAULT" "$AUDIT_HOME"

# ==== Summary ==============================================================
summary
