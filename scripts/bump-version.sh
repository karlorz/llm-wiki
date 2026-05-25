#!/usr/bin/env bash
# bump-version.sh — Sync version across all skillwiki package manifests.
#
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 0.2.0-beta.5
#
# Updates version in these files:
#   1. packages/cli/package.json          (npm-published CLI)
#   2. packages/skills/.claude-plugin/plugin.json  (Claude plugin)
#   3. packages/skills/.codex-plugin/plugin.json   (Codex plugin)
#   4. packages/skills/package.json        (skills package)
#   5. .claude-plugin/marketplace.json     (metadata.version + plugins[*].version)
#   6. packages/shared/package.json        (shared types — internal)
#   7. package.json                        (monorepo root — internal)
#   8. packages/vault-sync/.claude-plugin/plugin.json (vault-sync Claude plugin)
#   9. packages/vault-sync/.codex-plugin/plugin.json  (vault-sync Codex plugin)
#
# After editing, verifies all 7 files have the new version.

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

bump_file() {
  local label="$1" file="$2" global="${3:-}"
  sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/${global}" "$file" && rm -f "${file}.bak"
  echo "  ✓ ${label}"
}

bump_file "packages/cli/package.json"              "${REPO_ROOT}/packages/cli/package.json"
bump_file "packages/skills/.claude-plugin/plugin.json" "${REPO_ROOT}/packages/skills/.claude-plugin/plugin.json"
bump_file "packages/skills/.codex-plugin/plugin.json" "${REPO_ROOT}/packages/skills/.codex-plugin/plugin.json"
bump_file "packages/skills/package.json"           "${REPO_ROOT}/packages/skills/package.json"
bump_file ".claude-plugin/marketplace.json (×2)"   "${REPO_ROOT}/.claude-plugin/marketplace.json" "g"
bump_file "packages/shared/package.json"           "${REPO_ROOT}/packages/shared/package.json"
bump_file "package.json (root)"                    "${REPO_ROOT}/package.json"
bump_file "packages/vault-sync/.claude-plugin/plugin.json" "${REPO_ROOT}/packages/vault-sync/.claude-plugin/plugin.json"
bump_file "packages/vault-sync/.codex-plugin/plugin.json"  "${REPO_ROOT}/packages/vault-sync/.codex-plugin/plugin.json"

echo ""
echo "Verifying all files..."

EXPECTED_FILES=(
  "${REPO_ROOT}/packages/cli/package.json"
  "${REPO_ROOT}/packages/skills/.claude-plugin/plugin.json"
  "${REPO_ROOT}/packages/skills/.codex-plugin/plugin.json"
  "${REPO_ROOT}/packages/skills/package.json"
  "${REPO_ROOT}/packages/shared/package.json"
  "${REPO_ROOT}/package.json"
  "${REPO_ROOT}/packages/vault-sync/.claude-plugin/plugin.json"
  "${REPO_ROOT}/packages/vault-sync/.codex-plugin/plugin.json"
)

MISSING=0
for file in "${EXPECTED_FILES[@]}"; do
  if ! grep -q "\"version\": \"${VERSION}\"" "$file"; then
    echo "  ⚠ Missing version ${VERSION} in ${file}" >&2
    MISSING=$((MISSING + 1))
  fi
done

if ! grep -q "\"version\": \"${VERSION}\"" "${REPO_ROOT}/.claude-plugin/marketplace.json"; then
  echo "  ⚠ Missing version ${VERSION} in .claude-plugin/marketplace.json" >&2
  MISSING=$((MISSING + 1))
fi

if [ "$MISSING" -eq 0 ]; then
  echo "  ✓ All 9 manifest version fields updated to ${VERSION}"
else
  echo "  ⚠ Expected 9 manifests at ${VERSION}, found ${MISSING} mismatch(es)" >&2
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
