#!/usr/bin/env bash
# Readiness probe for SkillWiki HTTP MCP: fail closed without token,
# never print the bearer, parse plugin MCP JSON.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="$REPO_ROOT/packages/skills/scripts/check_readiness.py"
ROOT_PROBE="$REPO_ROOT/scripts/check_readiness.py"
SKILL="$REPO_ROOT/packages/skills/skillwiki-mcp/SKILL.md"
CONNECT="$REPO_ROOT/packages/skills/skillwiki-connect/SKILL.md"
MCP_JSON="$REPO_ROOT/packages/skills/.mcp.json"

JSON_FILES=(
  "$REPO_ROOT/packages/skills/mcp.json"
  "$MCP_JSON"
  "$REPO_ROOT/mcp.json"
  "$REPO_ROOT/.mcp.json"
  "$REPO_ROOT/packages/skills/cursor-cli-mcp.example.json"
  "$REPO_ROOT/cursor-cli-mcp.example.json"
)

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
assert_file "$SKILL"
assert_file "$CONNECT"
for json_path in "${JSON_FILES[@]}"; do
  assert_file "$json_path"
done

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

MISSING_OUT="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-missing.XXXXXX")"
MISSING_ERR="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-missing-err.XXXXXX")"
PRESENT_OUT="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-present.XXXXXX")"
PRESENT_ERR="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-present-err.XXXXXX")"
SSH_MISSING_OUT="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-ssh-missing.XXXXXX")"
SSH_MISSING_ERR="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-ssh-missing-err.XXXXXX")"
SSH_PRESENT_OUT="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-ssh-present.XXXXXX")"
SSH_PRESENT_ERR="$(mktemp "${TMPDIR:-/tmp}/skillwiki-readiness-ssh-present-err.XXXXXX")"
cleanup() {
  rm -f "$MISSING_OUT" "$MISSING_ERR" "$PRESENT_OUT" "$PRESENT_ERR" \
    "$SSH_MISSING_OUT" "$SSH_MISSING_ERR" "$SSH_PRESENT_OUT" "$SSH_PRESENT_ERR"
}
trap cleanup EXIT

# Missing token: fail closed (exit 2), missing_prereq, no secret leakage.
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

MISSING_WARN="$(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1])).get('warnings') or []))" "$MISSING_OUT")"
if printf '%s' "$MISSING_WARN" | grep -Fq "headless_oauth_loopback"; then
  printf 'FAIL: non-SSH missing token must not warn headless_oauth_loopback\n'
  FAIL=$((FAIL + 1))
else
  printf 'PASS: non-SSH missing token has no headless_oauth_loopback warning\n'
  PASS=$((PASS + 1))
fi

set +e
run_probe SSH_CONNECTION="1.2.3.4 12345 5.6.7.8 22" >"$SSH_MISSING_OUT" 2>"$SSH_MISSING_ERR"
SSH_MISSING_RC=$?
set -e
assert_eq "SSH missing token exit code" "2" "$SSH_MISSING_RC"
SSH_MISSING_STATUS="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status',''))" "$SSH_MISSING_OUT")"
assert_eq "SSH missing token status" "missing_prereq" "$SSH_MISSING_STATUS"
SSH_MISSING_WARN="$(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1])).get('warnings') or []))" "$SSH_MISSING_OUT")"
if printf '%s' "$SSH_MISSING_WARN" | grep -Fq "headless_oauth_loopback"; then
  printf 'PASS: SSH missing token warns headless_oauth_loopback\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: SSH missing token must warn headless_oauth_loopback: %s\n' "$SSH_MISSING_WARN"
  FAIL=$((FAIL + 1))
fi
if printf '%s' "$SSH_MISSING_WARN" | grep -Fq "operator browser" && \
   printf '%s' "$SSH_MISSING_WARN" | grep -Fq "this host" && \
   printf '%s' "$SSH_MISSING_WARN" | grep -Fq "hint"; then
  printf 'PASS: SSH missing token warning contains operator browser, this host, and hint\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: SSH missing token warning missing required discriminator copy: %s\n' "$SSH_MISSING_WARN"
  FAIL=$((FAIL + 1))
fi
if printf '%s' "$SSH_MISSING_WARN" | grep -Eq 'DISPLAY|headed|auto-detect'; then
  printf 'FAIL: SSH missing token warning must not contain DISPLAY, headed, or auto-detect: %s\n' "$SSH_MISSING_WARN"
  FAIL=$((FAIL + 1))
else
  printf 'PASS: SSH missing token warning does not contain DISPLAY, headed, or auto-detect\n'
  PASS=$((PASS + 1))
fi
if grep -Eiq 'sk-|bearer |token=' "$SSH_MISSING_OUT" "$SSH_MISSING_ERR"; then
  printf 'FAIL: SSH missing-token output leaked a token-like string\n'
  FAIL=$((FAIL + 1))
else
  printf 'PASS: SSH missing-token output does not print a token\n'
  PASS=$((PASS + 1))
fi

# Present token: in_sync, default URL, token never printed.
TOKEN_VALUE="test-token-must-not-appear-in-output"
set +e
run_probe SKILLWIKI_MCP_TOKEN="$TOKEN_VALUE" >"$PRESENT_OUT" 2>"$PRESENT_ERR"
PRESENT_RC=$?
set -e

assert_eq "present token exit code" "0" "$PRESENT_RC"

eval "$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
print("PRESENT_STATUS=" + json.dumps(str(data.get("status", ""))))
print("PRESENT_URL=" + json.dumps(str(data.get("url", ""))))
' "$PRESENT_OUT")"
assert_eq "present token status" "in_sync" "$PRESENT_STATUS"
assert_eq "default production URL" "https://wiki.karldigi.dev/mcp" "$PRESENT_URL"

if grep -Fq "$TOKEN_VALUE" "$PRESENT_OUT" "$PRESENT_ERR"; then
  printf 'FAIL: probe printed the bearer token\n'
  FAIL=$((FAIL + 1))
else
  printf 'PASS: probe does not print the bearer token\n'
  PASS=$((PASS + 1))
fi

set +e
run_probe SKILLWIKI_MCP_TOKEN="$TOKEN_VALUE" SSH_TTY="/dev/pts/0" >"$SSH_PRESENT_OUT" 2>"$SSH_PRESENT_ERR"
SSH_PRESENT_RC=$?
set -e
assert_eq "SSH present token exit code" "0" "$SSH_PRESENT_RC"
SSH_PRESENT_STATUS="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('status',''))" "$SSH_PRESENT_OUT")"
assert_eq "SSH present token status" "in_sync" "$SSH_PRESENT_STATUS"
SSH_PRESENT_WARN="$(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1])).get('warnings') or []))" "$SSH_PRESENT_OUT")"
if printf '%s' "$SSH_PRESENT_WARN" | grep -Fq "headless_oauth_loopback"; then
  printf 'FAIL: SSH with token must not warn headless_oauth_loopback: %s\n' "$SSH_PRESENT_WARN"
  FAIL=$((FAIL + 1))
else
  printf 'PASS: SSH with token has no headless_oauth_loopback warning\n'
  PASS=$((PASS + 1))
fi
if grep -Fq "$TOKEN_VALUE" "$SSH_PRESENT_OUT" "$SSH_PRESENT_ERR"; then
  printf 'FAIL: SSH present-token probe printed the bearer token\n'
  FAIL=$((FAIL + 1))
else
  printf 'PASS: SSH present-token probe does not print the bearer token\n'
  PASS=$((PASS + 1))
fi

for json_path in "${JSON_FILES[@]}"; do
  assert_json_file "$json_path"
done

if python3 - "$MCP_JSON" <<'PY'
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
then
  printf 'PASS: .mcp.json HTTP MCP contract\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: .mcp.json HTTP MCP contract\n'
  FAIL=$((FAIL + 1))
fi

CURSOR_PLUGIN="$REPO_ROOT/packages/skills/.cursor-plugin/plugin.json"
CURSOR_MCP="$REPO_ROOT/packages/skills/mcp.json"
CURSOR_MARKET="$REPO_ROOT/.cursor-plugin/marketplace.json"
VAULT_CURSOR_PLUGIN="$REPO_ROOT/packages/vault-sync/.cursor-plugin/plugin.json"
assert_file "$CURSOR_PLUGIN"
assert_file "$CURSOR_MARKET"
assert_file "$VAULT_CURSOR_PLUGIN"
assert_json_file "$CURSOR_PLUGIN"
assert_json_file "$CURSOR_MARKET"
assert_json_file "$VAULT_CURSOR_PLUGIN"

if python3 - "$CURSOR_PLUGIN" "$CURSOR_MCP" "$CURSOR_MARKET" "$VAULT_CURSOR_PLUGIN" <<'PY'
import json
import sys

plugin_path, mcp_path, market_path, vault_path = sys.argv[1:5]
plugin = json.load(open(plugin_path))
mcp = json.load(open(mcp_path))
market = json.load(open(market_path))
vault = json.load(open(vault_path))
errors = []

required = (plugin.get("variables") or {}).get("required") or []
props = ((plugin.get("variables") or {}).get("properties") or {})
if "SKILLWIKI_MCP_TOKEN" not in required:
    errors.append("cursor plugin must require SKILLWIKI_MCP_TOKEN")
if "SKILLWIKI_MCP_TOKEN" not in props:
    errors.append("cursor plugin must declare SKILLWIKI_MCP_TOKEN")
if "SKILLWIKI_EXTRA_VAULTS" in required:
    errors.append("cursor plugin must not require SKILLWIKI_EXTRA_VAULTS")
if "SKILLWIKI_EXTRA_VAULTS" not in props:
    errors.append("cursor plugin must declare optional SKILLWIKI_EXTRA_VAULTS")
if props.get("SKILLWIKI_EXTRA_VAULTS", {}).get("type") != "string":
    errors.append("SKILLWIKI_EXTRA_VAULTS must be a string Configure field")
if plugin.get("mcpServers") != "./mcp.json":
    errors.append("cursor plugin mcpServers must be ./mcp.json")

server = mcp["mcpServers"]["skillwiki"]
if server.get("type") != "http":
    errors.append("cursor mcp type")
if server.get("url") != "https://wiki.karldigi.dev/mcp":
    errors.append("cursor mcp url must be absolute production (no ${VAR:-default})")
auth = (server.get("headers") or {}).get("Authorization", "")
if auth != "Bearer ${SKILLWIKI_MCP_TOKEN}":
    errors.append("cursor mcp Authorization")

names = [p.get("name") for p in market.get("plugins") or []]
if "skillwiki" not in names:
    errors.append("cursor marketplace missing skillwiki")
if "vault-sync" not in names:
    errors.append("cursor marketplace missing vault-sync")
skillwiki = next(p for p in market["plugins"] if p["name"] == "skillwiki")
source = skillwiki.get("source", "").lstrip("./")
if source != "packages/skills":
    errors.append("cursor marketplace skillwiki source")
if vault.get("name") != "vault-sync":
    errors.append("vault-sync cursor plugin name")
if errors:
    sys.stderr.write("\n".join(errors) + "\n")
    sys.exit(1)
PY
then
  printf 'PASS: Cursor/Grok Bot plugin token contract (grok-search shape)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: Cursor/Grok Bot plugin token contract (grok-search shape)\n'
  FAIL=$((FAIL + 1))
fi

if grep -Fq "wiki_capture" "$SKILL" && grep -Fq "wiki_log_append" "$SKILL"; then
  printf 'PASS: skill names wiki_capture and wiki_log_append\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: skill missing wiki_capture / wiki_log_append\n'
  FAIL=$((FAIL + 1))
fi
if grep -Fq "headless_oauth_loopback" "$SKILL"; then
  printf 'PASS: skill mentions headless_oauth_loopback\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: skill missing headless_oauth_loopback\n'
  FAIL=$((FAIL + 1))
fi
if grep -Fiq "do not tell the operator to click the login link on another machine" "$SKILL"; then
  printf 'PASS: skill forbids completing OAuth login on another machine\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: skill does not forbid completing OAuth login on another machine\n'
  FAIL=$((FAIL + 1))
fi
if grep -Ei "raw/transcripts/" "$SKILL" | grep -Eiq "never|do not|don't"; then
  printf 'PASS: skill forbids local raw/transcripts capture writes\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: skill does not forbid local raw/transcripts capture writes\n'
  FAIL=$((FAIL + 1))
fi
if grep -Fiq "complete SkillWiki OAuth login in a laptop browser" "$CONNECT"; then
  printf 'PASS: skillwiki-connect forbids laptop OAuth login for SSH hosts\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: skillwiki-connect missing SSH OAuth loopback rule\n'
  FAIL=$((FAIL + 1))
fi
if grep -Fq "skillwiki connect --from-file" "$CONNECT"; then
  printf 'PASS: skillwiki-connect names --from-file overlay\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: skillwiki-connect missing skillwiki connect --from-file\n'
  FAIL=$((FAIL + 1))
fi
if cmp -s "$PROBE" "$ROOT_PROBE"; then
  printf 'PASS: scripts/check_readiness.py matches packages/skills probe\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: scripts/check_readiness.py diverges from packages/skills probe\n'
  FAIL=$((FAIL + 1))
fi

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
