#!/usr/bin/env bash
# Generate-only finance-digest collect. No MCP canonical write. No Telegram.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${FINANCE_DIGEST_MODE:-shadow}"
if [[ "$MODE" != "shadow" ]]; then
  echo "collect-dry-run.sh only supports MODE=shadow" >&2
  exit 2
fi
OUT_DIR="${FINANCE_DIGEST_OUT_DIR:-/tmp/wiki-fin-shadow-$(date -u +%Y-%m-%dT%H-%MZ)}"
FIXTURE="${FINANCE_DIGEST_FIXTURE:-$ROOT/scripts/wiki-fin/fixtures/sample-headlines.json}"
exec python3 "$ROOT/scripts/wiki-fin/finance-news-collector.py" \
  --mode shadow \
  --out-dir "$OUT_DIR" \
  --fixture "$FIXTURE"
