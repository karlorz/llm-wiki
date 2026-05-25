#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
STATUS_SH="$SCRIPT_DIR/status.sh"

if [ ! -f "$STATUS_SH" ]; then
  echo "FAIL: missing status script at $STATUS_SH" >&2
  exit 1
fi

out_file="$(mktemp)"
set +e
bash "$STATUS_SH" --read-only --restart-jobs >"$out_file" 2>&1
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  cat "$out_file" >&2
  rm -f "$out_file"
  echo "FAIL: expected non-zero exit when --read-only blocks --restart-jobs" >&2
  exit 1
fi

if ! grep -q 'refuses state-changing action: restart-jobs' "$out_file"; then
  cat "$out_file" >&2
  rm -f "$out_file"
  echo "FAIL: expected explicit read-only refusal message" >&2
  exit 1
fi

rm -f "$out_file"
echo "PASS: --read-only refuses state-changing call (--restart-jobs)"
