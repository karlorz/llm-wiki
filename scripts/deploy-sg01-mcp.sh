#!/usr/bin/env bash
# Deploy an exact llm-wiki ref to sg01's native-systemd MCP bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST="sg01"
REF=""
EXECUTE=false
READY_TIMEOUT_SECONDS=600

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-sg01-mcp.sh --ref <git-ref> [options]

Options:
  --host <ssh-host>          SSH target (default: sg01)
  --ref <git-ref>            Exact release ref, for example v0.10.95
  --ready-timeout <seconds>  Reconcile-ready deadline (default: 600)
  --execute                  Perform the deployment (default: dry-run)
  -h, --help                 Show this help

The remote deployment builds every runtime referenced by enabled sg01 units,
atomically swaps /opt/llm-wiki, restarts only skillwiki-mcp.service, and rolls
back if service health or initial S3 reconciliation fails.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host requires a value}"; shift 2 ;;
    --ref) REF="${2:?--ref requires a value}"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT_SECONDS="${2:?--ready-timeout requires a value}"; shift 2 ;;
    --execute) EXECUTE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$REF" ]; then
  echo "Error: --ref is required" >&2
  exit 2
fi
if ! [[ "$READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: --ready-timeout must be a positive integer" >&2
  exit 2
fi
for command_name in git ssh scp; do
  command -v "$command_name" >/dev/null || {
    echo "Error: required command not found: $command_name" >&2
    exit 1
  }
done

PIN="$(git -C "$REPO_ROOT" rev-parse "${REF}^{}")"
VERSION="$(git -C "$REPO_ROOT" show "${REF}:packages/mcp-server/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"
TRENDS_VERSION="$(git -C "$REPO_ROOT" show "${REF}:packages/agent-memory-trends/package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"
if [ "$VERSION" != "$TRENDS_VERSION" ]; then
  echo "Error: MCP version $VERSION differs from agent-memory-trends $TRENDS_VERSION" >&2
  exit 1
fi
cat <<EOF
sg01 MCP deployment plan
  host: $HOST
  ref: $REF
  pin: $PIN
  version: $VERSION
  ready timeout: ${READY_TIMEOUT_SECONDS}s
  builds: @skillwiki/mcp-server, @skillwiki/agent-memory-trends
  service restart: skillwiki-mcp.service only
EOF

if [ "$EXECUTE" != true ]; then
  echo "Dry-run only. Re-run with --execute to deploy."
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_ARCHIVE="$(mktemp "${TMPDIR:-/tmp}/llm-wiki-${VERSION}.XXXXXX.tar")"
REMOTE_ARCHIVE="/tmp/llm-wiki-${VERSION}-${STAMP}.tar"
trap 'rm -f "$LOCAL_ARCHIVE"' EXIT

git -C "$REPO_ROOT" archive --format=tar --output="$LOCAL_ARCHIVE" "$REF"
scp -q "$LOCAL_ARCHIVE" "$HOST:$REMOTE_ARCHIVE"

ssh "$HOST" bash -s -- "$REMOTE_ARCHIVE" "$PIN" "$VERSION" "$READY_TIMEOUT_SECONDS" <<'REMOTE'
set -euo pipefail

ARCHIVE="$1"
PIN="$2"
VERSION="$3"
READY_TIMEOUT_SECONDS="$4"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE="/opt/llm-wiki-stage-$STAMP"
BACKUP="/opt/llm-wiki-${VERSION}-rollback-$STAMP"
FAILED="/opt/llm-wiki-failed-$STAMP"

SWAPPED=false
cleanup() {
  rm -f "$ARCHIVE"
  if [ -d "$STAGE" ]; then
    rm -rf "$STAGE"
  fi
}
rollback() {
  rc=$?
  case "$rc" in 0) rc=130 ;; esac
  trap - ERR INT TERM HUP
  if [ "$SWAPPED" = true ] && [ -d "$BACKUP" ]; then
    echo "Deployment failed after swap; rolling back to $BACKUP" >&2
    systemctl stop skillwiki-mcp.service || true
    if [ -d /opt/llm-wiki ]; then
      mv /opt/llm-wiki "$FAILED" || true
    fi
    mv "$BACKUP" /opt/llm-wiki
    systemctl start skillwiki-mcp.service
  else
    echo "Deployment failed before swap; live bundle left untouched" >&2
  fi
  cleanup
  exit "$rc"
}
trap rollback ERR INT TERM HUP

mkdir -p "$STAGE"
tar -xf "$ARCHIVE" -C "$STAGE"
printf '%s\n' "$PIN" > "$STAGE/.deploy-pin"
cd "$STAGE"
npm ci --ignore-scripts --no-audit --no-fund
npm run -w @skillwiki/mcp-server build
npm run -w @skillwiki/agent-memory-trends build

test -s packages/mcp-server/dist/server.js
test -s packages/agent-memory-trends/dist/cli.js
node -e 'const p=require("./packages/mcp-server/package.json"); if (p.version !== process.argv[1]) process.exit(1)' "$VERSION"
node packages/agent-memory-trends/dist/cli.js --help >/dev/null

# Fail closed if a production unit does not expose or lacks its deployed entry point.
for unit in skillwiki-mcp.service skillwiki-research.service skillwiki-session-brief.service; do
  systemctl cat "$unit" >/dev/null 2>&1
  unit_text="$(systemctl cat "$unit")"
  mapfile -t paths < <(printf '%s\n' "$unit_text" | grep -Eo '/opt/llm-wiki/[^[:space:];]*/dist/[^[:space:];]+' | sort -u)
  test "${#paths[@]}" -gt 0
  for path in "${paths[@]}"; do
    rel="${path#/opt/llm-wiki/}"
    test -s "$STAGE/$rel"
  done
done

systemctl stop skillwiki-mcp.service
mv /opt/llm-wiki "$BACKUP"
mv "$STAGE" /opt/llm-wiki
SWAPPED=true
chown -R root:root /opt/llm-wiki
systemctl start skillwiki-mcp.service

ready=0
for _ in $(seq 1 "$READY_TIMEOUT_SECONDS"); do
  if systemctl is-failed --quiet skillwiki-mcp.service; then
    echo "skillwiki-mcp.service entered failed state" >&2
    false
  fi
  if systemctl is-active --quiet skillwiki-mcp.service; then
    health="$(curl -fsS --max-time 2 http://127.0.0.1:8801/health 2>/dev/null || true)"
    case "$health" in
      *'"reconcile_ready":true'*) ready=1; break ;;
    esac
  fi
  sleep 1
done
test "$ready" = 1
systemctl is-active --quiet skillwiki-mcp.service
test "$(cat /opt/llm-wiki/.deploy-pin)" = "$PIN"
test -s /opt/llm-wiki/packages/mcp-server/dist/server.js
test -s /opt/llm-wiki/packages/agent-memory-trends/dist/cli.js
curl -fsS --max-time 5 http://127.0.0.1:8801/health | grep -q '"reconcile_ready":true'

trap - ERR INT TERM HUP
cleanup
echo "Deployed skillwiki MCP $VERSION ($PIN)"
echo "Rollback bundle: $BACKUP"
REMOTE
