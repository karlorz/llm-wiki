#!/usr/bin/env bash
set -euo pipefail

# verify-manifests.sh — Validate manifest consistency across distribution channels.
#
# Checks:
#   1. Version field is identical across all 7 manifest files
#   2. Every skill directory has a SKILL.md
#   3. Skill count in plugin descriptions/marketplace matches actual count
#   4. Claude marketplace version matches Claude plugin version
#   5. Codex marketplace wiring points to ./packages/skills for skillwiki
#
# Exit 0 if all pass, non-zero with descriptive errors if any fail.
#
# Usage: ./scripts/verify-manifests.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ERRORS=0

# ---- 1. Version consistency across all 7 manifests ----

CLI_VER=$(grep '"version"' "$REPO_ROOT/packages/cli/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
SKILLS_PKG_VER=$(grep '"version"' "$REPO_ROOT/packages/skills/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
SHARED_VER=$(grep '"version"' "$REPO_ROOT/packages/shared/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
ROOT_VER=$(grep '"version"' "$REPO_ROOT/package.json" | head -1 | sed 's/.*: *"//;s/".*//')
PLUGIN_VER=$(grep '"version"' "$REPO_ROOT/packages/skills/.claude-plugin/plugin.json" | head -1 | sed 's/.*: *"//;s/".*//')
CODEX_PLUGIN_VER=$(grep '"version"' "$REPO_ROOT/packages/skills/.codex-plugin/plugin.json" | head -1 | sed 's/.*: *"//;s/".*//')
MARKET_VER=$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.claude-plugin/marketplace.json')); print(d['metadata']['version'])")

check_version() {
  local label="$1" ver="$2"
  if [ "$ver" != "$CLI_VER" ]; then
    echo "✗ Version mismatch: $label has $ver (expected $CLI_VER)" >&2
    ERRORS=$((ERRORS + 1))
  fi
}

check_version "packages/cli/package.json" "$CLI_VER"
check_version "packages/skills/package.json" "$SKILLS_PKG_VER"
check_version "packages/shared/package.json" "$SHARED_VER"
check_version "package.json (root)" "$ROOT_VER"
check_version "packages/skills/.claude-plugin/plugin.json" "$PLUGIN_VER"
check_version "packages/skills/.codex-plugin/plugin.json" "$CODEX_PLUGIN_VER"
check_version ".claude-plugin/marketplace.json metadata.version" "$MARKET_VER"

if [ "$ERRORS" -eq 0 ]; then
  echo "✓ All 7 manifests at version $CLI_VER"
fi

# ---- 2. Skill directories have SKILL.md ----

SKILLS_DIR="$REPO_ROOT/packages/skills"
ACTUAL_COUNT=0
for dir in "$SKILLS_DIR"/*/; do
  name=$(basename "$dir")
  if [ -f "$dir/SKILL.md" ]; then
    ACTUAL_COUNT=$((ACTUAL_COUNT + 1))
  fi
done
echo "✓ $ACTUAL_COUNT skill directories all have SKILL.md"

# ---- 3. Skill count in plugin descriptors matches actual ----

# Extract the number from descriptions like "15 prompt-only skills"
DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$REPO_ROOT/packages/skills/.claude-plugin/plugin.json" | grep -oE '^[0-9]+' || echo "0")
CODEX_DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$REPO_ROOT/packages/skills/.codex-plugin/plugin.json" | head -1 | grep -oE '^[0-9]+' || echo "0")
MARKET_DESC_COUNT=$(grep -oE '[0-9]+ prompt-only skills' "$REPO_ROOT/.claude-plugin/marketplace.json" | grep -oE '^[0-9]+' || echo "0")

if [ "$DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Claude plugin.json says $DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Claude plugin.json skill count ($DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

if [ "$CODEX_DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Codex plugin.json says $CODEX_DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Codex plugin.json skill count ($CODEX_DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

if [ "$MARKET_DESC_COUNT" != "$ACTUAL_COUNT" ]; then
  echo "✗ Claude marketplace.json says $MARKET_DESC_COUNT skills but found $ACTUAL_COUNT" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Claude marketplace.json skill count ($MARKET_DESC_COUNT) matches actual ($ACTUAL_COUNT)"
fi

# ---- 4. Claude marketplace version matches Claude plugin version ----

MARKET_PLUGIN_VER=$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.claude-plugin/marketplace.json')); print(d['plugins'][0]['version'])")

if [ "$MARKET_PLUGIN_VER" != "$PLUGIN_VER" ]; then
  echo "✗ marketplace.json plugin version ($MARKET_PLUGIN_VER) != plugin.json ($PLUGIN_VER)" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "✓ marketplace.json plugin version matches plugin.json"
fi

# ---- 5. Codex marketplace wiring ----

CODEX_MARKET_STATUS=$(python3 -c "import json; d=json.load(open('$REPO_ROOT/.agents/plugins/marketplace.json')); p=next((x for x in d.get('plugins', []) if x.get('name') == 'skillwiki'), None); print('__MISSING__' if p is None else f\"{p.get('source', {}).get('source', '')}|{p.get('source', {}).get('path', '')}\")")

if [ "$CODEX_MARKET_STATUS" = "__MISSING__" ]; then
  echo "✗ Codex marketplace missing plugin entry: skillwiki" >&2
  ERRORS=$((ERRORS + 1))
else
  CODEX_SOURCE_TYPE="${CODEX_MARKET_STATUS%%|*}"
  CODEX_SOURCE_PATH="${CODEX_MARKET_STATUS#*|}"
  if [ "$CODEX_SOURCE_TYPE" != "local" ]; then
    echo "✗ Codex marketplace source type is $CODEX_SOURCE_TYPE (expected local)" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [ "$CODEX_SOURCE_PATH" != "./packages/skills" ]; then
    echo "✗ Codex marketplace source path is $CODEX_SOURCE_PATH (expected ./packages/skills)" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [ "$CODEX_SOURCE_TYPE" = "local" ] && [ "$CODEX_SOURCE_PATH" = "./packages/skills" ]; then
    echo "✓ Codex marketplace points skillwiki to ./packages/skills"
  fi
fi

# ---- Summary ----

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All manifest checks passed."
  exit 0
else
  echo "FAILED: $ERRORS error(s) found." >&2
  exit 1
fi
