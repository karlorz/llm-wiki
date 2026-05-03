#!/usr/bin/env bash
# scripts/e2e-remote.sh
# End-to-end smoke tests for the skillwiki CLI on a remote Debian host (sg01).
#
# Prerequisites:
#   - ssh sg01 works with key auth
#   - Remote host has Node.js 20+
#   - Remote host has skillwiki published to npm (or installs it below)
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
printf "\n--- Install skillwiki on %s ---\n" "$SSH_HOST"

install_output=$(ssh "$SSH_HOST" "npm install -g skillwiki@0.2.0-beta.1 2>&1 | tail -1") || true
printf "  npm: %s\n" "$install_output"

version_output=$(ssh "$SSH_HOST" "skillwiki --version" 2>/dev/null) || true
ec=$?
assert_exit 0 "$ec" "skillwiki --version on remote"
printf "  version: %s\n" "$version_output"

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

output=$(ssh "$SSH_HOST" "skillwiki init --domain 'E2E Remote Test' --taxonomy 'research,concept,tool' --lang en" 2>/dev/null) || true
ec=$?
assert_exit 0 "$ec" "remote init succeeds"
assert_json_contains "$output" "data.imported_from_hermes" "true" "init detects Hermes fallback"

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

# We need to compute a stale date on the remote (GNU date).
# Send a self-contained script over SSH that creates all 8 test files.
ssh "$SSH_HOST" bash -s <<REMOTE_SEED
set -euo pipefail
VAULT="$VAULT_REMOTE"

mkdir -p "\$VAULT/entities" "\$VAULT/concepts" "\$VAULT/meta" "\$VAULT/raw/articles"

# GNU date (Debian)
stale_date=\$(date -d '120 days ago' '+%Y-%m-%d')

# ---- entities/valid-entity.md ----
cat > "\$VAULT/entities/valid-entity.md" <<'FRONTMATTER'
---
title: "Valid Entity"
tags: ["research"]
updated: "2026-05-03"
---

Links to [[valid-concept]].
FRONTMATTER

# ---- concepts/valid-concept.md ----
cat > "\$VAULT/concepts/valid-concept.md" <<'FRONTMATTER'
---
title: "Valid Concept"
tags: ["research"]
updated: "2026-05-03"
---

Links to [[valid-entity]].
FRONTMATTER

# ---- entities/orphan-entity.md (warning: orphans) ----
cat > "\$VAULT/entities/orphan-entity.md" <<'FRONTMATTER'
---
title: "Orphan Entity"
tags: ["research"]
updated: "2026-05-03"
---

No wikilinks here.
FRONTMATTER

# ---- concepts/broken-link.md (error: broken_wikilinks) ----
cat > "\$VAULT/concepts/broken-link.md" <<'FRONTMATTER'
---
title: "Broken Link"
tags: ["research"]
updated: "2026-05-03"
---

A link to [[nonexistent-page]].
FRONTMATTER

# ---- entities/bad-tag.md (error: tag_not_in_taxonomy) ----
cat > "\$VAULT/entities/bad-tag.md" <<'FRONTMATTER'
---
title: "Bad Tag"
tags: ["not-in-taxonomy"]
updated: "2026-05-03"
---

Normal content.
FRONTMATTER

# ---- concepts/stale-page.md (warning: stale_page) ----
cat > "\$VAULT/concepts/stale-page.md" <<FRONTMATTER
---
title: "Stale Page"
tags: ["research"]
updated: "\$stale_date"
sources: ["raw/articles/stale-source.md"]
---

Normal content.
FRONTMATTER

# ---- raw/articles/stale-source.md (companion for stale-page) ----
cat > "\$VAULT/raw/articles/stale-source.md" <<'FRONTMATTER'
---
title: "Stale Source"
ingested: "2026-05-03"
---

Source content
FRONTMATTER

# ---- entities/big-page.md (warning: page_too_large) ----
{
  printf -- '---\n'
  printf 'title: "Big Page"\n'
  printf 'tags: ["research"]\n'
  printf 'updated: "2026-05-03"\n'
  printf -- '---\n\n'
  i=0
  while [ "\$i" -lt 252 ]; do
    printf 'line content\n'
    i=\$((i + 1))
  done
} > "\$VAULT/entities/big-page.md"

# ---- log.md (warning: log_rotate_needed) ----
{
  printf -- '---\ntitle: "Changelog"\n---\n\n'
  i=0
  while [ "\$i" -lt 620 ]; do
    printf '## [2026-05-03] update | log entry %d\n\n' "\$i"
    i=\$((i + 1))
  done
} > "\$VAULT/log.md"

echo "Seeded \$VAULT"
REMOTE_SEED

if [ $? -eq 0 ]; then
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
output=$(ssh "$SSH_HOST" "skillwiki lint $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 23 "$ec" "remote lint (errors)"

# links → 16 (broken wikilinks)
output=$(ssh "$SSH_HOST" "skillwiki links $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 16 "$ec" "remote links (broken)"

# orphans → 0 (orphans is a warning, lint aggregates as warning; command succeeds)
output=$(ssh "$SSH_HOST" "skillwiki orphans $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 0 "$ec" "remote orphans (ok)"

# tag-audit → 17 (tag not in taxonomy)
output=$(ssh "$SSH_HOST" "skillwiki tag-audit $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 17 "$ec" "remote tag-audit (bad tag)"

# index-check → 18 (index incomplete)
output=$(ssh "$SSH_HOST" "skillwiki index-check $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 18 "$ec" "remote index-check (incomplete)"

# stale → 19 (stale page)
output=$(ssh "$SSH_HOST" "skillwiki stale $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 19 "$ec" "remote stale (stale page)"

# pagesize → 20 (page too large)
output=$(ssh "$SSH_HOST" "skillwiki pagesize $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 20 "$ec" "remote pagesize (oversized)"

# log-rotate → 21 (log rotate needed)
output=$(ssh "$SSH_HOST" "skillwiki log-rotate $VAULT_REMOTE" 2>/dev/null) || true
ec=$?
assert_exit 21 "$ec" "remote log-rotate (rotation needed)"

# ---------------------------------------------------------------------------
# 10. path --explain
# ---------------------------------------------------------------------------
printf "\n--- Remote path --explain ---\n"

output=$(ssh "$SSH_HOST" "skillwiki path --vault $VAULT_REMOTE --explain" 2>/dev/null) || true
ec=$?
assert_exit 0 "$ec" "remote path succeeds"
assert_json_contains "$output" "data.source" "flag" "remote path source is flag"

# ---------------------------------------------------------------------------
# 11. lang --explain
# ---------------------------------------------------------------------------
printf "\n--- Remote lang --explain ---\n"

output=$(ssh "$SSH_HOST" "skillwiki lang --lang chinese-traditional --explain" 2>/dev/null) || true
ec=$?
assert_exit 0 "$ec" "remote lang succeeds"
assert_json_contains "$output" "data.canonical" "zh-Hant" "remote lang resolves alias"

# ---------------------------------------------------------------------------
# 12. install on remote
# ---------------------------------------------------------------------------
printf "\n--- Remote install ---\n"

output=$(ssh "$SSH_HOST" "skillwiki install --target $INSTALL_TARGET" 2>/dev/null) || true
ec=$?
assert_exit 0 "$ec" "remote install succeeds"

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
