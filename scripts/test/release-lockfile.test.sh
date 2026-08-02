#!/bin/bash
# Regression tests for scripts/check-release-lockfile.mjs.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECKER="$REPO_ROOT/scripts/check-release-lockfile.mjs"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/release-lockfile-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS=0
FAIL=0

assert_pass() {
  local label="$1" file="$2"
  local out rc
  out="$(node "$CHECKER" 1.2.3 "$file" 2>&1)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — exit %s: %s\n" "$label" "$rc" "$out"
    FAIL=$((FAIL + 1))
  fi
}

assert_fail() {
  local label="$1" pattern="$2" file="$3"
  local out rc
  out="$(node "$CHECKER" 1.2.3 "$file" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -Fq "$pattern"; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected nonzero with '%s', got exit %s: %s\n" "$label" "$pattern" "$rc" "$out"
    FAIL=$((FAIL + 1))
  fi
}

write_valid_fixture() {
  local file="$1"
  cat > "$file" <<'JSON'
{
  "name": "fixture",
  "version": "1.2.3",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "version": "1.2.3",
      "workspaces": ["packages/versioned", "packages/unversioned"]
    },
    "packages/versioned": {"version": "1.2.3"},
    "packages/unversioned": {"private": true}
  }
}
JSON
}

valid="$TEST_ROOT/valid.json"
write_valid_fixture "$valid"
assert_pass "synchronized versioned and unversioned workspaces pass" "$valid"

stale_top="$TEST_ROOT/stale-top.json"
write_valid_fixture "$stale_top"
node -e 'const fs=require("fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p)); x.version="1.2.2"; fs.writeFileSync(p, JSON.stringify(x));' "$stale_top"
assert_fail "stale top-level version fails" "version: expected 1.2.3, found \"1.2.2\"" "$stale_top"

stale_root="$TEST_ROOT/stale-root.json"
write_valid_fixture "$stale_root"
node -e 'const fs=require("fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p)); x.packages[""].version="1.2.2"; fs.writeFileSync(p, JSON.stringify(x));' "$stale_root"
assert_fail "stale root-package version fails" 'packages[""].version: expected 1.2.3, found "1.2.2"' "$stale_root"

stale_workspace="$TEST_ROOT/stale-workspace.json"
write_valid_fixture "$stale_workspace"
node -e 'const fs=require("fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p)); x.packages["packages/versioned"].version="1.2.2"; fs.writeFileSync(p, JSON.stringify(x));' "$stale_workspace"
assert_fail "stale workspace version names its key" 'packages["packages/versioned"].version' "$stale_workspace"

unlisted_package="$TEST_ROOT/unlisted-package.json"
write_valid_fixture "$unlisted_package"
node -e 'const fs=require("fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p)); x.packages["packages/unlisted"]={version:"1.2.2"}; fs.writeFileSync(p, JSON.stringify(x));' "$unlisted_package"
assert_fail "unlisted versioned package cannot hide a stale version" 'packages["packages/unlisted"].version' "$unlisted_package"

missing_packages="$TEST_ROOT/missing-packages.json"
printf '{"version":"1.2.3"}\n' > "$missing_packages"
assert_fail "missing packages structure fails clearly" "packages: expected an object" "$missing_packages"

missing_root="$TEST_ROOT/missing-root.json"
printf '{"version":"1.2.3","packages":{}}\n' > "$missing_root"
assert_fail "missing root package fails clearly" 'packages[""]: expected a root package object' "$missing_root"

invalid_workspaces="$TEST_ROOT/invalid-workspaces.json"
printf '{"version":"1.2.3","packages":{"":{"version":"1.2.3","workspaces":"packages/cli"}}}\n' > "$invalid_workspaces"
assert_fail "malformed workspaces fail clearly" 'packages[""].workspaces: expected an array' "$invalid_workspaces"

missing_workspace="$TEST_ROOT/missing-workspace.json"
printf '{"version":"1.2.3","packages":{"":{"version":"1.2.3","workspaces":["packages/missing"]}}}\n' > "$missing_workspace"
assert_fail "missing workspace entry fails clearly" 'packages["packages/missing"]: expected a workspace package object' "$missing_workspace"

invalid_json="$TEST_ROOT/invalid.json"
printf '{not-json}\n' > "$invalid_json"
assert_fail "invalid JSON fails clearly" "cannot read or parse" "$invalid_json"

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
