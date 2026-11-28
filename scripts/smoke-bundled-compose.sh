#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
export MCP_IMAGE="${MCP_IMAGE:-skillwiki-mcp:ci}"
compose() { docker compose -p skillwiki-bundled-smoke -f docker-compose.coolify-bundled.yml "$@"; }
cleanup() {
  local status=$?
  trap - EXIT
  compose ps -a || true
  if [ "$status" -ne 0 ]; then
    compose logs --no-color --tail 100 || true
  fi
  compose down -v || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose config --quiet
timeout 300 docker compose -p skillwiki-bundled-smoke -f docker-compose.coolify-bundled.yml up -d
for _ in $(seq 1 60); do
  if compose exec -T mcp node -e '
    fetch("http://127.0.0.1:8801/health", { signal: AbortSignal.timeout(5000) })
      .then(async response => {
        const body = await response.text();
        console.log(`health status=${response.status} body=${body}`);
        if (!response.ok) process.exit(1);
        const health = JSON.parse(body);
        if (!(health.ok && health.reconcile_ready && health.s3_writable)) process.exit(1);
      })
      .catch(error => { console.error(error); process.exit(1); });
  '; then
    exit 0
  fi
  sleep 2
done
exit 1
