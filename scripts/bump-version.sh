#!/usr/bin/env bash
# bump-version.sh — Sync version across all skillwiki package manifests.
#
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.2.0-beta.5
#
# Updates version in these files:
#   1. packages/cli/package.json          (npm-published CLI)
#   2. packages/skills/.claude-plugin/plugin.json  (Claude plugin)
#   3. packages/skills/package.json        (skills package)
#   4. .claude-plugin/marketplace.json     (metadata.version + plugins[0].version)
#   5. packages/shared/package.json        (shared types — internal)
#   6. package.json                        (monorepo root — internal)
#
# After editing, verifies all 6 files have the new version.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.2.0-beta.5" >&2
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Validate version format (semver-ish)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: Invalid version format: $VERSION" >&2
  echo "Expected semver format: X.Y.Z or X.Y.Z-label" >&2
  exit 1
fi

echo "Bumping version to ${VERSION}..."

# 1. packages/cli/package.json
CLI_PKG="${REPO_ROOT}/packages/cli/package.json"
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$CLI_PKG" && rm -f "${CLI_PKG}.bak"
echo "  ✓ packages/cli/package.json"

# 2. packages/skills/.claude-plugin/plugin.json
PLUGIN_JSON="${REPO_ROOT}/packages/skills/.claude-plugin/plugin.json"
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$PLUGIN_JSON" && rm -f "${PLUGIN_JSON}.bak"
echo "  ✓ packages/skills/.claude-plugin/plugin.json"

# 3. packages/skills/package.json
SKILLS_PKG="${REPO_ROOT}/packages/skills/package.json"
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$SKILLS_PKG" && rm -f "${SKILLS_PKG}.bak"
echo "  ✓ packages/skills/package.json"

# 4. .claude-plugin/marketplace.json (two version fields)
MARKETPLACE="${REPO_ROOT}/.claude-plugin/marketplace.json"
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/g" "$MARKETPLACE" && rm -f "${MARKETPLACE}.bak"
echo "  ✓ .claude-plugin/marketplace.json (2 fields)"

# 5. packages/shared/package.json
SHARED_PKG="${REPO_ROOT}/packages/shared/package.json"
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$SHARED_PKG" && rm -f "${SHARED_PKG}.bak"
echo "  ✓ packages/shared/package.json"

# 6. package.json (root)
ROOT_PKG="${REPO_ROOT}/package.json"
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$ROOT_PKG" && rm -f "${ROOT_PKG}.bak"
echo "  ✓ package.json (root)"

echo ""
echo "Verifying all files..."

# Count occurrences of the new version
COUNT=$(git grep -c "\"version\": \"${VERSION}\"" -- '*.json' 2>/dev/null | grep -v ':0$' | wc -l | tr -d ' ')

if [ "$COUNT" -ge 6 ]; then
  echo "  ✓ All ${COUNT} version fields updated to ${VERSION}"
else
  echo "  ⚠ Expected 6+ version fields, found ${COUNT}" >&2
  git grep -n "\"version\": \"${VERSION}\"" -- '*.json'
  exit 1
fi

# Check for stale versions
STALE=$(git grep -n '"version"' -- '*.json' | grep -v "\"${VERSION}\"" | grep -v node_modules | grep -v package-lock || true)
if [ -n "$STALE" ]; then
  echo ""
  echo "  ⚠ Files with other versions:" >&2
  echo "$STALE" >&2
fi

echo ""
echo "Done. Run 'git diff' to review changes."
