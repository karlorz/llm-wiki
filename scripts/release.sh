#!/usr/bin/env bash
# Push a prepared skillwiki release commit and its matching tag.
#
# This script intentionally does not bump versions. Run `npm run bump <version>`
# first, commit the bump, create `v<version>` at that commit, then run this
# helper to push both release refs.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh <version> [--remote <name>] [--watch]

Publishes the prepared release refs:
  1. Verifies the working tree is clean.
  2. Verifies package.json has <version>.
  3. Verifies manifests with scripts/verify-manifests.sh.
  4. Verifies local tag v<version> exists and points at HEAD.
  5. Pushes main and v<version>.
  6. Optionally watches the tag-triggered publish workflow.

Examples:
  npm run bump 0.8.11
  git add -A && git commit -m "chore: bump version to 0.8.11"
  git tag -a v0.8.11 -m "v0.8.11"
  scripts/release.sh 0.8.11 --watch
USAGE
}

VERSION=""
REMOTE="origin"
WATCH=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --remote)
      if [ "$#" -lt 2 ]; then
        echo "Error: --remote requires a value" >&2
        exit 2
      fi
      REMOTE="$2"
      shift 2
      ;;
    --watch)
      WATCH=true
      shift
      ;;
    -*)
      echo "Error: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "Error: unexpected argument $1" >&2
        usage >&2
        exit 2
      fi
      VERSION="$1"
      shift
      ;;
  esac
done

if [ -z "$VERSION" ]; then
  usage >&2
  exit 2
fi

if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$'; then
  echo "Error: invalid version '$VERSION' (expected X.Y.Z or X.Y.Z-label)" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Error: release must run from main, current branch is '$CURRENT_BRANCH'" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is dirty; commit or stash changes before release" >&2
  git status --short >&2
  exit 1
fi

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [ "$PACKAGE_VERSION" != "$VERSION" ]; then
  echo "Error: package.json version is '$PACKAGE_VERSION', expected '$VERSION'" >&2
  echo "Run: npm run bump $VERSION" >&2
  exit 1
fi

bash scripts/verify-manifests.sh >/dev/null

TAG="v$VERSION"
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Error: local tag '$TAG' does not exist" >&2
  echo "Run: git tag -a $TAG -m \"$TAG\"" >&2
  exit 1
fi

HEAD_COMMIT="$(git rev-parse HEAD)"
TAG_COMMIT="$(git rev-parse "$TAG^{}")"
if [ "$TAG_COMMIT" != "$HEAD_COMMIT" ]; then
  echo "Error: tag '$TAG' points at $TAG_COMMIT, but HEAD is $HEAD_COMMIT" >&2
  exit 1
fi

REMOTE_TAG_COMMIT="$(
  git ls-remote --tags "$REMOTE" "refs/tags/$TAG^{}" | awk '{print $1}' | head -n 1
)"
if [ -z "$REMOTE_TAG_COMMIT" ]; then
  REMOTE_TAG_COMMIT="$(
    git ls-remote --tags "$REMOTE" "refs/tags/$TAG" | awk '{print $1}' | head -n 1
  )"
fi
if [ -n "$REMOTE_TAG_COMMIT" ] && [ "$REMOTE_TAG_COMMIT" != "$HEAD_COMMIT" ]; then
  echo "Error: remote tag '$TAG' already exists at $REMOTE_TAG_COMMIT, expected $HEAD_COMMIT" >&2
  exit 1
fi

echo "Pushing main to $REMOTE..."
git push "$REMOTE" main

echo "Pushing $TAG to $REMOTE..."
git push "$REMOTE" "$TAG"

echo "Release refs pushed: main and $TAG"

if [ "$WATCH" = true ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "Warning: gh CLI not found; cannot watch publish workflow" >&2
    exit 0
  fi
  echo "Waiting for publish workflow for $TAG..."
  sleep 5
  RUN_ID="$(gh run list --workflow publish.yml --event push --branch "$TAG" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  if [ -z "$RUN_ID" ]; then
    echo "Warning: publish workflow run for $TAG was not found yet" >&2
    exit 0
  fi
  gh run watch "$RUN_ID" --exit-status
fi
