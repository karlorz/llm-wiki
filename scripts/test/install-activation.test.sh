#!/usr/bin/env bash
# Regression tests for scripts/install-skillwiki-activation.sh
# Verifies Grok-only default and Claude/Codex SessionStart-hook skip/cleanup.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install-skillwiki-activation.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/install-activation-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS=0
FAIL=0

assert_pass() {
  local label="$1"
  printf "PASS: %s\n" "$label"
  PASS=$((PASS + 1))
}

assert_fail_msg() {
  local label="$1"
  local detail="$2"
  printf "FAIL: %s — %s\n" "$label" "$detail"
  FAIL=$((FAIL + 1))
}

# Isolate HOME so the installer never touches the real user profile.
export HOME="$TEST_ROOT/home"
mkdir -p "$HOME/.grok" "$HOME/.claude" "$HOME/.codex"

BEGIN_MARKER="<!-- skillwiki:begin -->"
END_MARKER="<!-- skillwiki:end -->"
# Prior dual-target installs used the relative ADR-6 form.
STALE_REFERENCE_LINE="Read @skillwiki.md for SkillWiki activation context."
GROK_REFERENCE_LINE="Read @~/.grok/skillwiki.md for SkillWiki activation context."
CLAUDE_REFERENCE_LINE="Read @~/.claude/skillwiki.md for SkillWiki activation context."
CODEX_REFERENCE_LINE="Read @~/.codex/skillwiki.md for SkillWiki activation context."

seed_prior_hooked_install() {
  local dir="$1"
  local agents_file="$2"
  mkdir -p "$dir"
  printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$STALE_REFERENCE_LINE" "$END_MARKER" > "$dir/$agents_file"
  cp "$REPO_ROOT/packages/skills/using-skillwiki/activation.md" "$dir/skillwiki.md"
}

# --- 1. Default install is Grok only ---
rm -rf "$HOME"
mkdir -p "$HOME"
out="$(bash "$INSTALLER" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] \
  && [ -f "$HOME/.grok/skillwiki.md" ] \
  && [ -f "$HOME/.grok/AGENTS.md" ] \
  && grep -qF "$BEGIN_MARKER" "$HOME/.grok/AGENTS.md" \
  && grep -qF "$GROK_REFERENCE_LINE" "$HOME/.grok/AGENTS.md" \
  && ! grep -qF "$STALE_REFERENCE_LINE" "$HOME/.grok/AGENTS.md" \
  && [ ! -e "$HOME/.claude/CLAUDE.md" ] \
  && [ ! -e "$HOME/.claude/skillwiki.md" ] \
  && [ ! -e "$HOME/.codex/AGENTS.md" ] \
  && [ ! -e "$HOME/.codex/skillwiki.md" ]; then
  assert_pass "default install is Grok only"
else
  assert_fail_msg "default install is Grok only" "rc=$rc out=$out files=$(find "$HOME" -type f 2>/dev/null | tr '\n' ' ')"
fi

# --- 2. Cleans prior Claude + Codex activation installs ---
rm -rf "$HOME"
mkdir -p "$HOME"
seed_prior_hooked_install "$HOME/.claude" "CLAUDE.md"
seed_prior_hooked_install "$HOME/.codex" "AGENTS.md"
# Keep Grok install path ready
mkdir -p "$HOME/.grok"
out="$(bash "$INSTALLER" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] \
  && [ ! -e "$HOME/.claude/CLAUDE.md" ] \
  && [ ! -e "$HOME/.claude/skillwiki.md" ] \
  && [ ! -e "$HOME/.codex/AGENTS.md" ] \
  && [ ! -e "$HOME/.codex/skillwiki.md" ] \
  && [ -f "$HOME/.grok/AGENTS.md" ]; then
  assert_pass "cleans prior Claude/Codex activation installs"
else
  assert_fail_msg "cleans prior Claude/Codex activation installs" "rc=$rc out=$out claude=$(ls -la "$HOME/.claude" 2>/dev/null) codex=$(ls -la "$HOME/.codex" 2>/dev/null)"
fi

# --- 3. Preserves non-marker content when cleaning Claude ---
rm -rf "$HOME"
mkdir -p "$HOME/.claude" "$HOME/.grok"
{
  printf '%s\n%s\n%s\n\n' "$BEGIN_MARKER" "$STALE_REFERENCE_LINE" "$END_MARKER"
  printf '%s\n' "# User instructions"
  printf '%s\n' "Keep this."
} > "$HOME/.claude/CLAUDE.md"
cp "$REPO_ROOT/packages/skills/using-skillwiki/activation.md" "$HOME/.claude/skillwiki.md"
bash "$INSTALLER" >/dev/null 2>&1
if [ -f "$HOME/.claude/CLAUDE.md" ] \
  && ! grep -qF "$BEGIN_MARKER" "$HOME/.claude/CLAUDE.md" \
  && grep -qF "Keep this." "$HOME/.claude/CLAUDE.md" \
  && [ ! -e "$HOME/.claude/skillwiki.md" ]; then
  assert_pass "cleaning Claude preserves non-marker content"
else
  assert_fail_msg "cleaning Claude preserves non-marker content" "content=$(cat "$HOME/.claude/CLAUDE.md" 2>/dev/null)"
fi

# --- 4. --with-claude opt-in installs Claude ---
rm -rf "$HOME"
mkdir -p "$HOME"
out="$(bash "$INSTALLER" --with-claude 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] \
  && [ -f "$HOME/.claude/skillwiki.md" ] \
  && [ -f "$HOME/.claude/CLAUDE.md" ] \
  && grep -qF "$BEGIN_MARKER" "$HOME/.claude/CLAUDE.md" \
  && grep -qF "$CLAUDE_REFERENCE_LINE" "$HOME/.claude/CLAUDE.md" \
  && [ -f "$HOME/.grok/AGENTS.md" ]; then
  assert_pass "--with-claude installs Claude activation"
else
  assert_fail_msg "--with-claude installs Claude activation" "rc=$rc out=$out"
fi

# --- 5. --with-codex opt-in installs Codex ---
rm -rf "$HOME"
mkdir -p "$HOME"
out="$(bash "$INSTALLER" --with-codex 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] \
  && [ -f "$HOME/.codex/skillwiki.md" ] \
  && [ -f "$HOME/.codex/AGENTS.md" ] \
  && grep -qF "$BEGIN_MARKER" "$HOME/.codex/AGENTS.md" \
  && grep -qF "$CODEX_REFERENCE_LINE" "$HOME/.codex/AGENTS.md"; then
  assert_pass "--with-codex installs Codex activation"
else
  assert_fail_msg "--with-codex installs Codex activation" "rc=$rc out=$out"
fi

# --- 6. check fails when Claude still has marker ---
rm -rf "$HOME"
mkdir -p "$HOME"
bash "$INSTALLER" >/dev/null 2>&1
seed_prior_hooked_install "$HOME/.claude" "CLAUDE.md"
out="$(bash "$INSTALLER" --check 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "CLAUDE.md still has skillwiki marker"; then
  assert_pass "check fails on residual Claude marker"
else
  assert_fail_msg "check fails on residual Claude marker" "rc=$rc out=$out"
fi

# --- 7. check passes after clean install ---
rm -rf "$HOME"
mkdir -p "$HOME"
bash "$INSTALLER" >/dev/null 2>&1
out="$(bash "$INSTALLER" --check 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
  assert_pass "check passes for Grok-only install"
else
  assert_fail_msg "check passes for Grok-only install" "rc=$rc out=$out"
fi

# --- 8. check fails on stale Grok @skillwiki.md marker ---
rm -rf "$HOME"
mkdir -p "$HOME"
bash "$INSTALLER" >/dev/null 2>&1
{
  printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$STALE_REFERENCE_LINE" "$END_MARKER"
} > "$HOME/.grok/AGENTS.md"
out="$(bash "$INSTALLER" --check 2>&1)"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "stale reference line"; then
  assert_pass "check fails on stale Grok @skillwiki.md marker"
else
  assert_fail_msg "check fails on stale Grok @skillwiki.md marker" "rc=$rc out=$out"
fi

# --- 9. apply upgrades a stale Grok marker ---
rm -rf "$HOME"
mkdir -p "$HOME/.grok"
{
  printf '%s\n%s\n%s\n' "$BEGIN_MARKER" "$STALE_REFERENCE_LINE" "$END_MARKER"
} > "$HOME/.grok/AGENTS.md"
cp "$REPO_ROOT/packages/skills/using-skillwiki/activation.md" "$HOME/.grok/skillwiki.md"
out="$(bash "$INSTALLER" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] \
  && grep -qF "$GROK_REFERENCE_LINE" "$HOME/.grok/AGENTS.md" \
  && ! grep -qF "$STALE_REFERENCE_LINE" "$HOME/.grok/AGENTS.md"; then
  assert_pass "apply upgrades stale Grok marker"
else
  assert_fail_msg "apply upgrades stale Grok marker" "rc=$rc out=$out agents=$(cat "$HOME/.grok/AGENTS.md" 2>/dev/null)"
fi

printf "\n%d passed, %d failed\n" "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
