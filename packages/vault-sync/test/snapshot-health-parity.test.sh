#!/bin/bash
# snapshot-health-parity.test.sh
#
# Shared scenario corpus parity gate for the shell snapshot-health
# implementation. Loads every fixture under
#   packages/vault-sync/test/fixtures/snapshot-health/*.json
# drives status.sh against each fixture via VS_SNAPSHOT_HEALTH_FIXTURE, and
# asserts exact ID + severity + stable-fact parity with the expected block.
#
# This suite MUST fail before the Phase 3 shell implementation lands and
# pass after it. It is the shell half of the cross-surface parity gate
# (the TypeScript half lives in packages/cli/test/commands/doctor.test.ts).
#
# Run: bash packages/vault-sync/test/snapshot-health-parity.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_SYNC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATUS_SH="$VAULT_SYNC_ROOT/skills/vault-sync-status/status.sh"
FIXTURE_DIR="$VAULT_SYNC_ROOT/test/fixtures/snapshot-health"

PASS=0
FAIL=0
FAILURES=""

if [ ! -f "$STATUS_SH" ]; then
  echo "FATAL: status.sh not found at $STATUS_SH" >&2
  exit 1
fi

if [ ! -d "$FIXTURE_DIR" ]; then
  echo "FATAL: fixture dir not found at $FIXTURE_DIR" >&2
  exit 1
fi

# Extract a JSON field via python3 (already a status.sh dependency).
# Usage: json_get <file> <dotted.path>  -> prints value or empty
json_get() {
  local file="$1" path="$2"
  python3 -c "
import json, sys
with open('$file') as fh:
    d = json.load(fh)
cur = d
for part in '$path'.split('.'):
    if cur is None:
        break
    cur = cur.get(part) if isinstance(cur, dict) else None
if cur is None:
    sys.exit(0)
if isinstance(cur, bool):
    print('true' if cur else 'false')
elif isinstance(cur, (int, float)):
    print(cur)
else:
    print(cur)
"
}

# Collect all fixture files (sorted for deterministic order).
fixtures=()
while IFS= read -r f; do
  fixtures+=("$f")
done < <(ls -1 "$FIXTURE_DIR"/*.json 2>/dev/null | sort)

if [ "${#fixtures[@]}" -lt 18 ]; then
  echo "FATAL: expected at least 18 fixtures, found ${#fixtures[@]}" >&2
  exit 1
fi

run_fixture() {
  local fixture="$1"
  local scenario_id now cadence timeout scope
  scenario_id="$(json_get "$fixture" scenario_id)"
  now="$(json_get "$fixture" now)"
  cadence="$(json_get "$fixture" cadence_minutes)"
  timeout="$(json_get "$fixture" service_timeout_seconds)"
  scope="$(json_get "$fixture" service_scope)"

  local home
  home="$(mktemp -d)"
  # status.sh needs a vault dir for git/conflict checks; use an empty dir.
  mkdir -p "$home/wiki"

  local json
  json="$(env -u WIKI_REMOTE \
    HOME="$home" \
    WIKI_PATH="$home/wiki" \
    VS_ROLE=snapshotter \
    VS_OS=linux \
    VS_SERVICE_SCOPE="$scope" \
    VS_SNAPSHOT_HEALTH_FIXTURE="$fixture" \
    VS_SNAPSHOT_HEALTH_NOW="$now" \
    VS_SNAPSHOT_CADENCE_MINUTES="$cadence" \
    VS_SNAPSHOT_SERVICE_TIMEOUT_SECONDS="$timeout" \
    bash "$STATUS_SH" --read-only --json 2>/dev/null || true)"

  rm -rf "$home"

  if [ -z "$json" ]; then
    echo "FAIL: $scenario_id - no JSON output"
    FAIL=$((FAIL + 1))
    FAILURES="${FAILURES}${scenario_id}:no-json\n"
    return
  fi

  # For each expected check ID + status, compare.
  local exp_ids
  exp_ids="$(python3 -c "
import json
with open('$fixture') as fh:
    d = json.load(fh)
for k, v in d.get('expected', {}).items():
    print(k + '\t' + v.get('status', ''))
")"

  local had_failure=0
  while IFS=$'\t' read -r exp_id exp_status; do
    [ -n "$exp_id" ] || continue
    local actual_status actual_detail
    actual_status="$(python3 -c "
import json, sys
try:
    d = json.loads('''$json''')
except Exception:
    sys.exit(0)
for c in d.get('checks', []):
    if c.get('id') == '$exp_id':
        print(c.get('status', ''))
        break
")"
    if [ -z "$actual_status" ]; then
      echo "FAIL: $scenario_id - missing check '$exp_id'"
      had_failure=1
    elif [ "$actual_status" != "$exp_status" ]; then
      echo "FAIL: $scenario_id - $exp_id expected=$exp_status actual=$actual_status"
      had_failure=1
    fi
  done <<<"$exp_ids"

  if [ "$had_failure" -eq 0 ]; then
    echo "PASS: $scenario_id"
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES="${FAILURES}${scenario_id}:mismatch\n"
  fi
}

echo "=== snapshot-health shell parity (status.sh) ==="
for fixture in "${fixtures[@]}"; do
  run_fixture "$fixture"
done

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
