#!/usr/bin/env bash
set -euo pipefail

# e2e-plugin.sh — Plugin channel E2E test for skillwiki on sg01.
# Verifies the Claude Code plugin discovers all skills and that
# the backing CLI commands work correctly through the plugin channel.
#
# Usage:  ./scripts/e2e-plugin.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"

SSH_HOST="sg01"
REMOTE_CLI="skillwiki"

# Read expected version from package.json (no manual updates needed)
EXPECTED_VERSION=$(grep '"version"' "$REPO_ROOT/packages/cli/package.json" | head -1 | sed 's/.*: *"//;s/".*//')

# Count expected skills dynamically from repo (no manual updates needed)
EXPECTED_SKILLS=$(find "$REPO_ROOT/packages/skills" -maxdepth 2 -name 'SKILL.md' | wc -l | tr -d ' ')

# Count discoverable CLI skills (wiki-*, proj-*) dynamically (no manual updates needed)
EXPECTED_DISC=$(ls "$REPO_ROOT/packages/skills" | grep -cE '^(wiki-|proj-)')

printf "=== Plugin E2E (sg01) ===\n\n"

# ---- 0. Verify plugin version ----
printf "%s\n" "--- Plugin version ---"
PLUGIN_VERSION=$(ssh "$SSH_HOST" "find /root/.claude/plugins/cache/llm-wiki/skillwiki/ -name plugin.json -exec head -4 {} \; 2>/dev/null | grep version | head -1 | sed 's/.*: \"\\(.*\\)\",/\\1/'")
if [ "$PLUGIN_VERSION" = "$EXPECTED_VERSION" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 plugin version is %s\n" "$PLUGIN_VERSION"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 plugin version is %s, expected %s\n" "$PLUGIN_VERSION" "$EXPECTED_VERSION"
fi

# ---- 1. Verify plugin installed with expected skills ----
printf "%s\n" "--- Plugin installation ---"
SKILL_COUNT=$(ssh "$SSH_HOST" "find /root/.claude/plugins/cache/llm-wiki/skillwiki/ -name 'SKILL.md' 2>/dev/null | wc -l")
if [ "$SKILL_COUNT" -eq "$EXPECTED_SKILLS" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 plugin has %s SKILL.md files\n" "$SKILL_COUNT"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 plugin has %s SKILL.md files, expected %s\n" "$SKILL_COUNT" "$EXPECTED_SKILLS"
fi

# Verify skill discovery via claude (using-skillwiki is hook-injected, not listed by /skills)
DISCOVERED=$(ssh "$SSH_HOST" "claude -p 'list skills starting with wiki- or proj-. names only, one per line, nothing else.' 2>&1")
DISC_COUNT=$(printf '%s' "$DISCOVERED" | grep -cE '^(wiki-|proj-)' || true)
if [ "$DISC_COUNT" -eq "$EXPECTED_DISC" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 claude discovers all %s CLI skills\n" "$EXPECTED_DISC"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 claude discovered %s/%s CLI skills\n" "$DISC_COUNT" "$EXPECTED_DISC"
fi

# Verify specific skills are present (dynamic from repo)
CLI_SKILLS=$(ls "$REPO_ROOT/packages/skills" | grep -E '^(wiki-|proj-)' | sort)
for skill in $CLI_SKILLS; do
  if printf '%s' "$DISCOVERED" | grep -q "^${skill}$"; then
    PASS=$((PASS + 1)); printf "  \u2713 skill '%s' discoverable\n" "$skill"
  else
    FAIL=$((FAIL + 1)); printf "  \u2717 skill '%s' NOT discoverable\n" "$skill"
  fi
done

# ---- 2. Test wiki-init skill can run init via CLI ----
printf "\n--- wiki-init skill (init round-trip) ---\n"
VAULT=$(ssh "$SSH_HOST" "mktemp -d")
TEMP_HOME=$(ssh "$SSH_HOST" "mktemp -d")

run_cli ssh "$SSH_HOST" "HOME=$TEMP_HOME $REMOTE_CLI init --target $VAULT --domain 'Plugin E2E' --taxonomy 'research,concept,tool' --lang en"
assert_exit 0 "$RUN_RC" "plugin e2e init succeeds"

for dir in raw/articles entities concepts meta; do
  if ssh "$SSH_HOST" "test -d $VAULT/$dir" 2>/dev/null; then
    PASS=$((PASS + 1)); printf "  \u2713 vault has %s/\n" "$dir"
  else
    FAIL=$((FAIL + 1)); printf "  \u2717 vault missing %s/\n" "$dir"
  fi
done

# ---- 3. Test wiki-lint skill (lint via CLI) ----
printf "\n--- wiki-lint skill (lint via CLI) ---\n"
REMOTE_COMMON="/tmp/sw-plugin-$(date +%s).sh"
scp "$SCRIPT_DIR/e2e-common.sh" "$SSH_HOST:$REMOTE_COMMON" >/dev/null
rc=0
ssh "$SSH_HOST" "source $REMOTE_COMMON && seed_vault $VAULT && rm -f $REMOTE_COMMON" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1)); printf "  \u2713 seed_vault on remote\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 seed_vault on remote failed\n"
fi

run_cli ssh "$SSH_HOST" "$REMOTE_CLI lint $VAULT"
assert_exit 23 "$RUN_RC" "plugin e2e lint detects errors"

# ---- 4. Test config command ----
printf "\n--- config via CLI (backing wiki-* skills) ---\n"
run_cli ssh "$SSH_HOST" "HOME=$TEMP_HOME $REMOTE_CLI config list"
assert_exit 0 "$RUN_RC" "config list succeeds"

run_cli ssh "$SSH_HOST" "HOME=$TEMP_HOME $REMOTE_CLI config set WIKI_LANG de"
assert_exit 0 "$RUN_RC" "config set succeeds"

run_cli ssh "$SSH_HOST" "HOME=$TEMP_HOME $REMOTE_CLI config get WIKI_LANG"
assert_exit 0 "$RUN_RC" "config get succeeds"
assert_json_contains "$RUN_OUTPUT" "data.value" "de" "config get round-trip"

# ---- 5. Test doctor ----
printf "\n--- doctor via CLI ---\n"
run_cli ssh "$SSH_HOST" "HOME=$TEMP_HOME WIKI_PATH=$VAULT $REMOTE_CLI doctor"
# TEMP_HOME has no ~/.claude/skills/ so skills_installed warns → exit 28
assert_exit 28 "$RUN_RC" "doctor exits 28 (skills_installed warn)"
assert_json_contains "$RUN_OUTPUT" "data.summary.error" "0" "doctor 0 errors"
assert_json_contains "$RUN_OUTPUT" "data.summary.warn" "2" "doctor 2 warns (skills_installed + temp vault)"

# ---- 6. CI guard: canonical typed-knowledge CLI refs ----
printf "\n--- cli_refs guard (canonical vault) ---\n"
CANONICAL_VAULT="/root/wiki"
run_cli ssh "$SSH_HOST" "$REMOTE_CLI lint $CANONICAL_VAULT --only cli_refs"
assert_exit 0 "$RUN_RC" "canonical vault has zero typed-knowledge cli_refs"
assert_json_contains "$RUN_OUTPUT" "data.summary.info" "0" "cli_refs summary info is zero"

# ---- 7. Cleanup ----
ssh "$SSH_HOST" "rm -rf $VAULT $TEMP_HOME" 2>/dev/null || true

# ---- Summary ----
printf "\n"
summary
