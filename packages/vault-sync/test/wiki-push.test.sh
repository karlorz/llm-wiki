#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-push.sh.

set -u

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-push.sh"
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

make_script_dir() {
  local root="$1"
  local script_dir="$root/scripts"
  mkdir -p "$script_dir/lib"
  cp "$SCRIPT_UNDER_TEST" "$script_dir/wiki-push.sh"
  cp "$(dirname "$SCRIPT_UNDER_TEST")/lib/platform.sh" "$script_dir/lib/platform.sh"
  cp "$(dirname "$SCRIPT_UNDER_TEST")/lib/lockfile.sh" "$script_dir/lib/lockfile.sh"
  chmod +x "$script_dir/wiki-push.sh"
  printf '%s\n' "$script_dir"
}

write_stub_rclone() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
echo "Transferred:   	    1 B / 1 B, 100%, 1 B/s, ETA 0s"
exit 0
STUB
  chmod +x "$bin_dir/rclone"
}

test_pull_helper_sees_clean_tree() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"

  local remote_work="$root/remote-work"
  git clone --branch main "$root/origin.git" "$remote_work" >/dev/null
  printf 'remote\n' > "$remote_work/remote.md"
  git_commit "$remote_work" remote
  git -C "$remote_work" push origin main >/dev/null

  printf 'local dirty\n' > "$vault/note.md"
  mkdir -p "$home/.config/rclone"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
if [ -z "$(git status --porcelain)" ]; then
  echo clean > "$HELPER_STATE_FILE"
else
  echo dirty > "$HELPER_STATE_FILE"
fi
exit 0
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  HELPER_STATE_FILE="$root/helper-state" \
    HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "pull helper is called after dirty edits are committed" "$(cat "$root/helper-state" 2>/dev/null || true)" "clean"
  rm -rf "$root"
}

test_clean_ahead_commit_is_pushed() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  mkdir -p "$home/.config/rclone"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  printf 'local\n' > "$vault/local.md"
  git_commit "$vault" local
  local local_head
  local_head="$(git -C "$vault" rev-parse HEAD)"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  local remote_head
  remote_head="$(git --git-dir="$root/origin.git" rev-parse refs/heads/main)"
  assert_eq "clean ahead commit is pushed" "$remote_head" "$local_head"
  rm -rf "$root"
}

test_sync_lock_is_not_committed() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  mkdir -p "$home/.config/rclone" "$vault/.skillwiki"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  printf 'local\n' > "$vault/local.md"
  printf 'lock\n' > "$vault/.skillwiki/sync.lock"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "sync lock remains untracked" "$(git -C "$vault" ls-files .skillwiki/sync.lock)" ""
  assert_eq "real local edit is pushed" "$(git --git-dir="$root/origin.git" show main:local.md 2>/dev/null || true)" "local"
  if git --git-dir="$root/origin.git" cat-file -e main:.skillwiki/sync.lock 2>/dev/null; then
    lock_state="present"
  else
    lock_state="absent"
  fi
  assert_eq "sync lock is absent from remote" "$lock_state" "absent"
  rm -rf "$root"
}

test_pull_helper_sees_clean_tree
test_clean_ahead_commit_is_pushed
test_sync_lock_is_not_committed

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
