#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

node "$REPO_ROOT/packages/vault-sync/scripts/generate-systemd-property-catalog.mjs" --check
