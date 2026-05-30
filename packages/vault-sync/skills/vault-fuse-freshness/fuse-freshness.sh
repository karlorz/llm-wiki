#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPANION="$VAULT_SYNC_ROOT/scripts/wiki-fuse-refresh.sh"

if [ ! -x "$COMPANION" ]; then
  echo "FATAL: missing companion script: $COMPANION" >&2
  exit 1
fi

exec bash "$COMPANION" "$@"
