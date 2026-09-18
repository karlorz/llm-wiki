#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/deploy-sg01-mcp.sh"
DOC="$ROOT/docs/sg01-mcp-deployment.md"

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

bash -n "$SCRIPT" || fail "deployment script parses"
pass "deployment script parses"

grep -q 'READY_TIMEOUT_SECONDS=600' "$SCRIPT" || fail "600-second default readiness gate"
pass "600-second default readiness gate"

grep -q 'npm run -w @skillwiki/mcp-server build' "$SCRIPT" || fail "MCP runtime build"
grep -q 'npm run -w @skillwiki/agent-memory-trends build' "$SCRIPT" || fail "agent-memory runtime build"
grep -Fq 'await import("./packages/mcp-server/dist/server.js")' "$SCRIPT" || fail "MCP bundle import preflight"
pass "both sg01 runtimes are built"

grep -q 'reconcile_ready.*true' "$SCRIPT" || fail "reconcile-ready health gate"
grep -q 'SWAPPED=false' "$SCRIPT" || fail "pre-swap state guard"
grep -q 'failed after swap' "$SCRIPT" || fail "post-swap rollback path"
grep -q 'failed before swap' "$SCRIPT" || fail "pre-swap leaves live bundle untouched"
grep -q 'systemctl is-failed' "$SCRIPT" || fail "fast failed-unit detection"
grep -q 'trap rollback ERR INT TERM HUP' "$SCRIPT" || fail "interruption rollback traps"
if grep -Fq '[ -d "$STAGE" ] && rm -rf "$STAGE"' "$SCRIPT"; then
  fail "cleanup must not report failure after the stage directory is atomically moved"
fi
pass "health gate and guarded rollback are present"

grep -q 'grep -Eo.*opt/llm-wiki' "$SCRIPT" || fail "runtime path extraction"
# Match literal deployed-script source.
# shellcheck disable=SC2016
grep -Fq 'test "${#paths[@]}" -gt 0' "$SCRIPT" || fail "runtime path extraction fail-closed"
pass "systemd runtime path validation fails closed"

grep -q 'skillwiki-backend\.target' "$SCRIPT" || fail "backend target check present"
grep -q 'systemctl is-enabled skillwiki-backend\.target' "$SCRIPT" || fail "backend target is-enabled check present"
grep -q 'service restart: skillwiki-mcp\.service only' "$SCRIPT" || fail "restart remains MCP-only"
pass "backend target validation and single-service restart verified"

grep -q '22,000 objects' "$DOC" || fail "runbook records production object scale"
grep -q '600 seconds' "$DOC" || fail "runbook records readiness timeout"
pass "runbook records production readiness evidence"

if bash "$SCRIPT" --ref HEAD 2>&1 | grep -q 'Dry-run only'; then
  pass "default invocation is dry-run"
else
  fail "default invocation must be dry-run"
fi

if bash "$SCRIPT" 2>/dev/null; then
  fail "missing --ref must fail"
else
  pass "missing --ref fails"
fi
if bash "$SCRIPT" --ref HEAD --ready-timeout nope 2>/dev/null; then
  fail "invalid readiness timeout must fail"
else
  pass "invalid readiness timeout fails"
fi
