#!/usr/bin/env bash
set -euo pipefail

# e2e-plugin.sh — Plugin channel E2E test for skillwiki.
# Verifies the Claude Code plugin discovers all skills and that
# the backing CLI commands work correctly through the plugin channel.
#
# Reads HOST_ENV to select the target host. Default: scripts/hosts/sg01.env,
# which is production/snapshotter infrastructure and only runs the read-only
# branch declared in that host profile. Use an explicitly prepared non-prod
# host profile for the full plugin exercise.
#
# Usage:
#   bash scripts/e2e-plugin.sh
#   HOST_ENV=scripts/hosts/sg02.env bash scripts/e2e-plugin.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "$SCRIPT_DIR/e2e-common.sh"
source "$SCRIPT_DIR/lib/host-env.sh"

HOST_ENV="${HOST_ENV:-$SCRIPT_DIR/hosts/sg01.env}"
host_env_load "$HOST_ENV"

if [ "${HOST_CLASS:-}" = "prod-linux" ] && [ "${READONLY_VERIFY:-}" != "true" ]; then
  echo "FATAL: prod-linux plugin E2E targets must set READONLY_VERIFY=true"
  exit 1
fi

SSH_TARGET="${SSH_USER}@${SSH_HOST}"
REMOTE_CLI="skillwiki"
CLAUDE_E2E_MODEL="${CLAUDE_E2E_MODEL:-sonnet}"
CLI_REFS_GUARD_VAULT_PATH="${READONLY_GUARD_VAULT_PATH:-$VAULT_PATH}"

# Read expected version from package.json (no manual updates needed)
EXPECTED_VERSION=$(grep '"version"' "$REPO_ROOT/packages/cli/package.json" | head -1 | sed 's/.*: *"//;s/".*//')

# Count expected Claude and Codex skill layouts dynamically from repo
# (no manual updates needed). Claude discovers the root-level skill folders;
# Codex discovers the packages/codex-skills/skills mirror.
EXPECTED_SKILLS=$(find "$REPO_ROOT/packages/skills" -maxdepth 2 -name 'SKILL.md' | wc -l | tr -d ' ')
EXPECTED_CODEX_SKILLS=$(find -L "$REPO_ROOT/packages/codex-skills/skills" -maxdepth 2 -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')

# Count discoverable CLI skills (wiki-*, proj-*) dynamically (no manual updates needed)
EXPECTED_DISC=$(ls "$REPO_ROOT/packages/skills" | grep -cE '^(wiki-|proj-)')

assert_cli_refs_guard() {
  run_cli ssh "$SSH_TARGET" "$REMOTE_CLI lint '$CLI_REFS_GUARD_VAULT_PATH' --only cli_refs"
  if [ "$RUN_RC" -eq 0 ]; then
    assert_exit 0 "$RUN_RC" "canonical vault has zero typed-knowledge cli_refs"
    assert_json_contains "$RUN_OUTPUT" "data.summary.info" "0" "cli_refs summary info is zero"
    return
  fi

  if [ "$READONLY_VERIFY" = "true" ] && { [ "${PLUGIN_VERSION:-}" != "$EXPECTED_VERSION" ] || [ "${REMOTE_CLI_VERSION:-}" != "$EXPECTED_VERSION" ]; }; then
    if printf '%s' "$RUN_OUTPUT" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const summary = parsed?.data?.summary ?? {};
    process.exit(summary.errors === 0 && summary.warnings === 0 ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
'; then
      PASS=$((PASS + 1))
      printf "  ⚠ cli_refs reports info-only findings under read-only version skew (plugin=%s, cli=%s, expected=%s)\n" "${PLUGIN_VERSION:-unknown}" "${REMOTE_CLI_VERSION:-unknown}" "$EXPECTED_VERSION"
    else
      FAIL=$((FAIL + 1))
      printf "  ✗ cli_refs guard failed under read-only version skew\n"
      printf "%s\n" "$RUN_OUTPUT"
    fi
    return
  fi

  assert_exit 0 "$RUN_RC" "canonical vault has zero typed-knowledge cli_refs"
  assert_json_contains "$RUN_OUTPUT" "data.summary.info" "0" "cli_refs summary info is zero"
}

printf "=== Plugin E2E (%s on %s) ===\n" "$HOST_CLASS" "$SSH_HOST"
printf "Mode    : %s\n" "$([ "$READONLY_VERIFY" = "true" ] && echo "read-only" || echo "full cycle")"
printf "Host env: %s\n" "$HOST_ENV"
printf "Guard   : %s\n\n" "$CLI_REFS_GUARD_VAULT_PATH"

REMOTE_HOME=$(ssh "$SSH_TARGET" "printf '%s' \"\$HOME\"")
PLUGIN_CACHE_ROOT="$REMOTE_HOME/.claude/plugins/cache/llm-wiki/skillwiki"

# ---- 0. Verify plugin version ----
printf "%s\n" "--- Plugin version ---"
PLUGIN_VERSION=$(ssh "$SSH_TARGET" "find '$PLUGIN_CACHE_ROOT' -maxdepth 3 -name plugin.json -exec head -4 {} \; 2>/dev/null | grep version | head -1 | sed 's/.*: \"\\(.*\\)\",/\\1/'")
if [ -z "$PLUGIN_VERSION" ]; then
  FAIL=$((FAIL + 1)); printf "  \u2717 plugin version not found under %s\n" "$PLUGIN_CACHE_ROOT"
elif [ "$PLUGIN_VERSION" = "$EXPECTED_VERSION" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 plugin version is %s\n" "$PLUGIN_VERSION"
elif [ "$READONLY_VERIFY" = "true" ]; then
  PASS=$((PASS + 1)); printf "  \u26a0 plugin version is %s, expected %s (read-only host not auto-upgraded)\n" "$PLUGIN_VERSION" "$EXPECTED_VERSION"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 plugin version is %s, expected %s\n" "$PLUGIN_VERSION" "$EXPECTED_VERSION"
fi

REMOTE_CLI_VERSION=$(ssh "$SSH_TARGET" "$REMOTE_CLI --version 2>/dev/null || true")
if [ "$REMOTE_CLI_VERSION" = "$EXPECTED_VERSION" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 remote CLI version is %s\n" "$REMOTE_CLI_VERSION"
elif [ "$READONLY_VERIFY" = "true" ]; then
  PASS=$((PASS + 1)); printf "  \u26a0 remote CLI version is %s, expected %s (read-only host not auto-upgraded)\n" "${REMOTE_CLI_VERSION:-unknown}" "$EXPECTED_VERSION"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 remote CLI version is %s, expected %s\n" "${REMOTE_CLI_VERSION:-unknown}" "$EXPECTED_VERSION"
fi

PLUGIN_ROOT="$PLUGIN_CACHE_ROOT/${PLUGIN_VERSION:-$EXPECTED_VERSION}"

# ---- 1. Verify plugin installed with expected skills ----
printf "%s\n" "--- Plugin installation ---"
SKILL_COUNT=$(ssh "$SSH_TARGET" "find '$PLUGIN_ROOT' -maxdepth 2 -name 'SKILL.md' 2>/dev/null | wc -l")
if [ "$SKILL_COUNT" -eq "$EXPECTED_SKILLS" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 plugin has %s root-level SKILL.md files\n" "$SKILL_COUNT"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 plugin has %s root-level SKILL.md files, expected %s\n" "$SKILL_COUNT" "$EXPECTED_SKILLS"
fi

CODEX_SKILL_COUNT=$(ssh "$SSH_TARGET" "find '$PLUGIN_ROOT' -path '*/skills/*/SKILL.md' 2>/dev/null | wc -l")
if [ "$CODEX_SKILL_COUNT" -eq "$EXPECTED_CODEX_SKILLS" ]; then
  PASS=$((PASS + 1)); printf "  \u2713 plugin has %s Codex mirror SKILL.md files\n" "$CODEX_SKILL_COUNT"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 plugin has %s Codex mirror SKILL.md files, expected %s\n" "$CODEX_SKILL_COUNT" "$EXPECTED_CODEX_SKILLS"
fi

if [ "$READONLY_VERIFY" = "true" ]; then
  printf "\n--- Read-only canonical vault guard ---\n"
  assert_cli_refs_guard

  printf "\n"
  summary
  exit 0
fi

# Verify skill discovery via claude (using-skillwiki is hook-injected, not listed by /skills)
DISCOVERED=$(ssh "$SSH_TARGET" "claude -p --model '$CLAUDE_E2E_MODEL' 'list skills starting with wiki- or proj-. names only, one per line, nothing else.' 2>&1")
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
VAULT=$(ssh "$SSH_TARGET" "mktemp -d")
TEMP_HOME=$(ssh "$SSH_TARGET" "mktemp -d")

cleanup() {
  ssh "$SSH_TARGET" "rm -rf '$VAULT' '$TEMP_HOME'" 2>/dev/null || true
}
trap cleanup EXIT

run_cli ssh "$SSH_TARGET" "HOME='$TEMP_HOME' $REMOTE_CLI init --target '$VAULT' --domain 'Plugin E2E' --taxonomy 'research,concept,tool' --lang en"
assert_exit 0 "$RUN_RC" "plugin e2e init succeeds"

for dir in raw/articles entities concepts meta; do
  if ssh "$SSH_TARGET" "test -d '$VAULT/$dir'" 2>/dev/null; then
    PASS=$((PASS + 1)); printf "  \u2713 vault has %s/\n" "$dir"
  else
    FAIL=$((FAIL + 1)); printf "  \u2717 vault missing %s/\n" "$dir"
  fi
done

# ---- 3. Test wiki-lint skill (lint via CLI) ----
printf "\n--- wiki-lint skill (lint via CLI) ---\n"
REMOTE_COMMON="/tmp/sw-plugin-$(date +%s).sh"
scp "$SCRIPT_DIR/e2e-common.sh" "$SSH_TARGET:$REMOTE_COMMON" >/dev/null
rc=0
ssh "$SSH_TARGET" "source '$REMOTE_COMMON' && seed_vault '$VAULT' && rm -f '$REMOTE_COMMON'" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  PASS=$((PASS + 1)); printf "  \u2713 seed_vault on remote\n"
else
  FAIL=$((FAIL + 1)); printf "  \u2717 seed_vault on remote failed\n"
fi

run_cli ssh "$SSH_TARGET" "$REMOTE_CLI lint '$VAULT'"
assert_exit 23 "$RUN_RC" "plugin e2e lint detects errors"

# ---- 4. Test config command ----
printf "\n--- config via CLI (backing wiki-* skills) ---\n"
run_cli ssh "$SSH_TARGET" "HOME='$TEMP_HOME' $REMOTE_CLI config list"
assert_exit 0 "$RUN_RC" "config list succeeds"

run_cli ssh "$SSH_TARGET" "HOME='$TEMP_HOME' $REMOTE_CLI config set WIKI_LANG de"
assert_exit 0 "$RUN_RC" "config set succeeds"

run_cli ssh "$SSH_TARGET" "HOME='$TEMP_HOME' $REMOTE_CLI config get WIKI_LANG"
assert_exit 0 "$RUN_RC" "config get succeeds"
assert_json_contains "$RUN_OUTPUT" "data.value" "de" "config get round-trip"

# ---- 5. Test doctor ----
printf "\n--- doctor via CLI ---\n"
run_cli ssh "$SSH_TARGET" "HOME='$TEMP_HOME' WIKI_PATH='$VAULT' $REMOTE_CLI doctor"
# TEMP_HOME has no ~/.claude/skills/ so skills_installed warns → exit 28
assert_exit 28 "$RUN_RC" "doctor exits 28 (skills_installed warn)"
assert_json_contains "$RUN_OUTPUT" "data.summary.error" "0" "doctor 0 errors"
assert_json_contains "$RUN_OUTPUT" "data.summary.warn" "2" "doctor 2 warns (skills_installed + temp vault)"

# ---- 6. CI guard: canonical typed-knowledge CLI refs ----
printf "\n--- cli_refs guard (canonical vault) ---\n"
assert_cli_refs_guard

# ---- 7. Cleanup ----
cleanup
trap - EXIT

# ---- Summary ----
printf "\n"
summary
