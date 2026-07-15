#!/bin/bash
# Regression tests for scripts/pack-cli.sh — pack destination must be outside packages/cli.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PACK_SH="$REPO_ROOT/scripts/pack-cli.sh"
PASS=0
FAIL=0

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — expected '%s', got '%s'\n" "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local label="$1"
  shift
  if "$@"; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s\n" "$label"
    FAIL=$((FAIL + 1))
  fi
}

# Resolve to the same physical path form (macOS /var vs /private/var).
realpath_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

test_pack_refuses_cli_package_dir() {
  set +e
  out="$(bash "$PACK_SH" --no-build --out "$REPO_ROOT/packages/cli" 2>&1)"
  rc=$?
  set -e
  assert_eq "refuse pack into packages/cli exit nonzero" "$rc" "2"
  assert_true "error mentions packages/cli" bash -c "printf '%s' \"\$1\" | grep -q 'packages/cli'" _ "$out"
}

test_pack_writes_to_artifacts_not_cli() {
  local dest out path version dest_phys path_dir path_phys
  dest="$(mktemp -d "${TMPDIR:-/tmp}/skillwiki-pack-test.XXXXXX")"
  dest="$(cd "$dest" && pwd -P)"

  # Ensure dist exists (build once if missing)
  if [ ! -f "$REPO_ROOT/packages/cli/dist/cli.js" ]; then
    npm run -w skillwiki build >/dev/null 2>&1
  fi

  # Remove any accidental package-dir tarball before pack
  rm -f "$REPO_ROOT/packages/cli"/skillwiki-*.tgz

  out="$(bash "$PACK_SH" --no-build --out "$dest" --json 2>/dev/null)"
  path="$(printf '%s' "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.path)})")"
  version="$(printf '%s' "$out" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.version)})")"

  path_dir="$(cd "$(dirname "$path")" && pwd -P)"
  path_phys="$path_dir/$(basename "$path")"

  assert_true "tarball exists at pack destination" test -f "$path"
  assert_eq "tarball dir is requested out dir" "$path_dir" "$dest"
  assert_true "tarball is not under packages/cli" bash -c 'case "$1" in */packages/cli/*) exit 1;; *) exit 0;; esac' _ "$path_phys"
  assert_eq "no tarball left in packages/cli" \
    "$(find "$REPO_ROOT/packages/cli" -maxdepth 1 -name 'skillwiki-*.tgz' 2>/dev/null | wc -l | tr -d ' ')" "0"
  assert_eq "json version matches package.json" \
    "$version" \
    "$(node -e "console.log(require('$REPO_ROOT/packages/cli/package.json').version)")"
  assert_true "tarball name matches skillwiki-VERSION.tgz" \
    bash -c 'basename "$1" | grep -Eq "^skillwiki-[0-9]+\.[0-9]+\.[0-9]+.*\.tgz$"' _ "$path"

  # Packaged CLI must ship the canonical vault-sync pull helper + sourced libs.
  helper_in_tgz="$(tar -tzf "$path" | grep -c 'package/dist/vault-sync/scripts/wiki-pull-with-auto-resolve.sh' || true)"
  assert_eq "tarball includes vault-sync pull helper" "$helper_in_tgz" "1"
  for lib in git-operation-journal.sh managed-write-lock.sh platform.sh lockfile.sh git-case.sh conflict-markers.sh git-rebase-state.sh git-materialization.sh; do
    count="$(tar -tzf "$path" | grep -c "package/dist/vault-sync/scripts/lib/$lib" || true)"
    assert_eq "tarball includes lib/$lib" "$count" "1"
  done

  rm -rf "$dest"
}

test_gitignore_covers_artifacts_and_tgz() {
  assert_true "gitignore has artifacts/" grep -qx 'artifacts/' "$REPO_ROOT/.gitignore"
  assert_true "gitignore has *.tgz" grep -qx '*.tgz' "$REPO_ROOT/.gitignore"
  # git check-ignore should treat artifacts path as ignored when present
  mkdir -p "$REPO_ROOT/artifacts/npm"
  touch "$REPO_ROOT/artifacts/npm/.keep-test"
  assert_eq "git check-ignore artifacts/npm" \
    "$(git -C "$REPO_ROOT" check-ignore -q artifacts/npm/.keep-test; echo $?)" "0"
  rm -f "$REPO_ROOT/artifacts/npm/.keep-test"
}

test_pack_refuses_cli_package_dir
test_pack_writes_to_artifacts_not_cli
test_gitignore_covers_artifacts_and_tgz

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
