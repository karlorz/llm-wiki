#!/usr/bin/env bash
# Readiness probe for SkillWiki HTTP MCP: fail closed without token,
# never print the bearer, parse plugin MCP JSON.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="$REPO_ROOT/packages/skills/scripts/check_readiness.py"
ROOT_PROBE="$REPO_ROOT/scripts/check_readiness.py"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf 'PASS: %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected %s, got %s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_file() {
  local path="$1"
  if [ -f "$path" ]; then
    printf 'PASS: exists %s\n' "$path"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: missing %s\n' "$path"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_file() {
  local path="$1"
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$path" 2>/dev/null; then
    printf 'PASS: json parse %s\n' "$path"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: json parse %s\n' "$path"
    FAIL=$((FAIL + 1))
  fi
}

assert_file "$PROBE"
assert_file "$ROOT_PROBE"
assert_file "$REPO_ROOT/packages/skills/mcp.json"
assert_file "$REPO_ROOT/packages/skills/.mcp.json"
assert_file "$REPO_ROOT/mcp.json"
assert_file "$REPO_ROOT/.mcp.json"
assert_file "$REPO_ROOT/packages/skills/cursor-cli-mcp.example.json"
assert_file "$REPO_ROOT/cursor-cli-mcp.example.json"
assert_file "$REPO_ROOT/packages/skills/skillwiki-mcp/SKILL.md"

if [ ! -f "$PROBE" ]; then
  printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
  exit 1
fi

run_probe() {
  env -u SKILLWIKI_MCP_TOKEN -u SKILLWIKI_MCP_URL -i \
    PATH="$PATH" \
    HOME="$HOME" \
    "$@" \
    python3 "$PROBE" --apply --json
}

# Missing token: fail closed (exit 2), missing_prereq, no secret leakage.
MISSING_OUT="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-missing.XXXXXX")"
MISSING_ERR="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-missing-err.XXXXXX")"
set +e
run_probe >"$MISSING_OUT" 2>"$MISSING_ERR"
MISSING_RC=$?
set -e

assert_eq "missing token exit code" "2" "$MISSING_RC"

MISSING_STATUS="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status',''))" "$MISSING_OUT")"
assert_eq "missing token status" "missing_prereq" "$MISSING_STATUS"

if grep -Eiq 'sk-|bearer |token=' "$MISSING_OUT" "$MISSING_ERR"; then
  printf 'FAIL: missing-token output leaked a token-like string\n'
  FAIL=$((FAIL + 1))
else
  printf 'PASS: missing-token output does not print a token\n'
  PASS=$((PASS + 1))
fi

# Present token: in_sync, default URL, token never printed.
TOKEN_VALUE="test-token-must-not-appear-in-output"
PRESENT_OUT="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-present.XXXXXX")"
PRESENT_ERR="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-present-err.XXXXXX")"
set +e
env -u SKILLWIKI_MCP_URL \
  SKILLWIKI_MCP_TOKEN="$TOKEN_VALUE" \
  python3 "$PROBE" --apply --json >"$PRESENT_OUT" 2>"$PRESENT_ERR"
PRESENT_RC=$?
set -e

assert_eq "present token exit code" "0" "$PRESENT_RC"

PRESENT_STATUS="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status',''))" "$PRESENT_OUT")"
assert_eq "present token status" "in_sync" "$PRESENT_STATUS"

PRESENT_URL="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('url',''))" "$PRESENT_OUT")"
assert_eq "default production URL" "https://wiki.karldigi.dev/mcp" "$PRESENT_URL"

if grep -Fq "$TOKEN_VALUE" "$PRESENT_OUT" "$PRESENT_ERR"; then
  printf 'FAIL: probe printed the bearer token\n'
  FAIL=$((FAIL + 1))
else
  printf 'PASS: probe does not print the bearer token\n'
  PASS=$((PASS + 1))
fi

for json_path in \
  "$REPO_ROOT/packages/skills/mcp.json" \
  "$REPO_ROOT/packages/skills/.mcp.json" \
  "$REPO_ROOT/mcp.json" \
  "$REPO_ROOT/.mcp.json" \
  "$REPO_ROOT/packages/skills/cursor-cli-mcp.example.json" \
  "$REPO_ROOT/cursor-cli-mcp.example.json"
do
  [ -f "$json_path" ] || continue
  assert_json_file "$json_path"
done

if [ -f "$REPO_ROOT/packages/skills/.mcp.json" ]; then
  python3 - "$REPO_ROOT/packages/skills/.mcp.json" <<'PY'
import json
import sys

path = sys.argv[1]
data = json.load(open(path))
server = data["mcpServers"]["skillwiki"]
errors = []
if server.get("type") != "http":
    errors.append("type")
url = server.get("url", "")
if "wiki.karldigi.dev/mcp" not in url:
    errors.append("url")
auth = (server.get("headers") or {}).get("Authorization", "")
if "${SKILLWIKI_MCP_TOKEN}" not in auth:
    errors.append("Authorization")
if "Bearer" not in auth:
    errors.append("Bearer")
sys.exit(1 if errors else 0)
PY
  if [ $? -eq 0 ]; then
    printf 'PASS: .mcp.json HTTP MCP contract\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: .mcp.json HTTP MCP contract\n'
    FAIL=$((FAIL + 1))
  fi
fi

SKILL="$REPO_ROOT/packages/skills/skillwiki-mcp/SKILL.md"
if [ -f "$SKILL" ]; then
  if grep -Fq "wiki_capture" "$SKILL" && grep -Fq "wiki_log_append" "$SKILL"; then
    printf 'PASS: skill names wiki_capture and wiki_log_append\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: skill missing wiki_capture / wiki_log_append\n'
    FAIL=$((FAIL + 1))
  fi
  if grep -Ei "raw/transcripts/" "$SKILL" | grep -Eiq "never|do not|don't"; then
    printf 'PASS: skill forbids local raw/transcripts capture writes\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: skill does not forbid local raw/transcripts capture writes\n'
    FAIL=$((FAIL + 1))
  fi
fi

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
