#!/bin/bash
# Keep the Python worker regressions in the normal test:vault-sync shell loop.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHONDONTWRITEBYTECODE=1 python3 "$SCRIPT_DIR/snapshot-requests.test.py"
