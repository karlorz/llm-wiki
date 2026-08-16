#!/usr/bin/env bash
# Contract: SkillWiki owns the brainstorming override (no writing-plans,
# no docs/superpowers/, no auto-commit). Canonical sources only.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
USING="$REPO_ROOT/packages/skills/using-skillwiki/SKILL.md"
PROJ="$REPO_ROOT/packages/skills/proj-work/SKILL.md"
ACTIVATION="$REPO_ROOT/packages/skills/using-skillwiki/activation.md"
GATE="$REPO_ROOT/packages/skills/wiki-gate-plan-mode/SKILL.md"

PASS=0
FAIL=0

assert_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    printf "FAIL: missing %s\n" "$path"
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

assert_contains() {
  local path="$1"
  local needle="$2"
  local label="$3"
  if grep -qF "$needle" "$path"; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — missing %s in %s\n" "$label" "$needle" "$path"
    FAIL=$((FAIL + 1))
  fi
}

assert_absent() {
  local path="$1"
  local needle="$2"
  local label="$3"
  if grep -qF "$needle" "$path"; then
    printf "FAIL: %s — still contains %s in %s\n" "$label" "$needle" "$path"
    FAIL=$((FAIL + 1))
  else
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  fi
}

assert_file "$USING" && assert_file "$PROJ" && assert_file "$ACTIVATION" && assert_file "$GATE"

assert_contains "$USING" "Never create \`docs/superpowers/\`" \
  "using-skillwiki forbids docs/superpowers"
assert_contains "$USING" "Do not invoke \`writing-plans\`" \
  "using-skillwiki forbids writing-plans"
assert_contains "$USING" "Do not git commit from brainstorming" \
  "using-skillwiki forbids brainstorming auto-commit"
assert_contains "$USING" "visual-companion.md" \
  "using-skillwiki names visual companion"
assert_contains "$USING" "Offer the companion once" \
  "using-skillwiki offers companion once"
assert_contains "$USING" "test-driven-development" \
  "using-skillwiki names standalone TDD"
assert_absent "$USING" "superpowers:writing-plans" \
  "using-skillwiki dropped writing-plans as the next skill"

assert_contains "$PROJ" "brainstorming writes \`spec.md\`" \
  "proj-work says brainstorming writes spec.md"
assert_contains "$PROJ" "Do not invoke \`writing-plans\`" \
  "proj-work forbids writing-plans"
assert_absent "$PROJ" "superpowers:writing-plans" \
  "proj-work no longer names writing-plans as a PRD consumer"

assert_contains "$ACTIVATION" "Do not invoke \`writing-plans\`" \
  "activation forbids writing-plans"
assert_contains "$ACTIVATION" "Never create \`docs/superpowers/\`" \
  "activation forbids docs/superpowers"
assert_contains "$ACTIVATION" "proj-work" \
  "activation still routes through proj-work"

assert_contains "$GATE" "proj-work" \
  "wiki-gate-plan-mode routes planning through proj-work"
assert_contains "$GATE" "brainstorming" \
  "wiki-gate-plan-mode still names brainstorming"
assert_absent "$GATE" "superpowers:writing-plans" \
  "wiki-gate-plan-mode dropped writing-plans"
assert_contains "$GATE" "Do not invoke writing-plans" \
  "wiki-gate-plan-mode forbids writing-plans"

printf "\n%d passed, %d failed\n" "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
