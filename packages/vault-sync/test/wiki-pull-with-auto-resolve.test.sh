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

make_repo() {
  local root="$1"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  git init --bare "$remote" >/dev/null
  mkdir -p "$vault"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null
  printf '%s\n' "$vault"
}

add_remote_commit() {
  local root="$1"
  local file="$2"
  local content="$3"
  local msg="$4"
  local remote_work="$root/remote-work-$msg"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  printf '%s\n' "$content" > "$remote_work/$file"
  git_commit "$remote_work" "$msg"
  git -C "$remote_work" push origin main >/dev/null
}

test_dirty_tree_pull_restores_edit() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  add_remote_commit "$root" "remote.md" "remote" "remote"
  printf 'local dirty\n' > "$vault/note.md"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "dirty-tree pull exits successfully" "$rc" "0"
  assert_eq "local branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "dirty tracked edit is restored" "$(cat "$vault/note.md")" "local dirty"
  assert_eq "remote commit is present" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"

  rm -rf "$root"
}

test_stale_rebase_state_is_cleaned_before_pull() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"

  add_remote_commit "$root" "remote.md" "remote" "remote-stale"
  mkdir -p "$vault/.git/rebase-merge"

  HOME="$home" WIKI_DIR="$vault" "$SCRIPT_UNDER_TEST" origin main >/dev/null 2>&1
  rc=$?

  assert_eq "stale rebase cleanup exits successfully" "$rc" "0"
  assert_eq "stale rebase directory removed" "$(test -d "$vault/.git/rebase-merge" && echo present || echo absent)" "absent"
  assert_eq "stale-cleaned branch is no longer behind" "$(git -C "$vault" rev-list --count HEAD..origin/main 2>/dev/null || echo unknown)" "0"
  assert_eq "remote commit after stale cleanup is present" "$(cat "$vault/remote.md" 2>/dev/null || true)" "remote"

  rm -rf "$root"
}

test_dirty_tree_pull_restores_edit
test_stale_rebase_state_is_cleaned_before_pull

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
