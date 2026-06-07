#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-pull-with-auto-resolve.sh.

set -u

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-pull-with-auto-resolve.sh"
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

git_commit() {
  local repo="$1" msg="$2"
  git -C "$repo" add -A >/dev/null
  git -C "$repo" -c user.name=test -c user.email=test@test commit -m "$msg" >/dev/null
}

root="$(mktemp -d)"
home="$root/home"
remote="$root/origin.git"
vault="$root/wiki"

git init --bare "$remote" >/dev/null
mkdir -p "$vault"
git -C "$vault" init >/dev/null
git -C "$vault" branch -M main
git -C "$vault" remote add origin "$remote"
printf 'base\n' > "$vault/note.md"
git_commit "$vault" init
git -C "$vault" push -u origin main >/dev/null

remote_work="$root/remote-work"
git clone --branch main "$remote" "$remote_work" >/dev/null
printf 'remote\n' > "$remote_work/remote.md"
git_commit "$remote_work" remote
git -C "$remote_work" push origin main >/dev/null

printf 'local dirty\n' > "$vault/note.md"

HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
rc=$?

assert_eq "dirty-tree pull exits successfully" "$rc" "0"
assert_eq "local branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
assert_eq "dirty tracked edit is restored" "$(cat "$vault/note.md")" "local dirty"
assert_eq "remote commit is present" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"

rm -rf "$root"

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
