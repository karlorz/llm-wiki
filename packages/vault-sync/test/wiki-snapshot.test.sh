#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-snapshot.sh.

set -u

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-snapshot.sh"
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

assert_contains() {
  local label="$1" needle="$2"
  if grep -q -- "$needle" "$SCRIPT_UNDER_TEST"; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — missing '%s'\n" "$label" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

if bash -n "$SCRIPT_UNDER_TEST"; then
  printf "PASS: wiki-snapshot.sh passes bash -n\n"
  PASS=$((PASS + 1))
else
  printf "FAIL: wiki-snapshot.sh fails bash -n\n"
  FAIL=$((FAIL + 1))
fi

assert_contains "snapshot preserves max-delete guard" "--max-delete 10"
assert_contains "snapshot has raw dedup guard function" "raw_dedup_guard()"
assert_contains "snapshot calls raw dedup guard before commit" "raw_dedup_guard; then"

if [ "$(uname -s)" != "Linux" ]; then
  printf "SKIP: Linux-only runtime snapshot guard test\n"
  printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

git_commit() {
  local repo="$1" msg="$2"
  git -C "$repo" add -A >/dev/null
  git -C "$repo" -c user.name=test -c user.email=test@test commit -m "$msg" >/dev/null
}

test_raw_dedup_guard_blocks_commit() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local cloud_dir="$root/cloud/wiki"
  local bin_dir="$root/bin"
  local log_file="$root/wiki-snapshot.log"
  local lock_file="$root/wiki-snapshot.lock"
  mkdir -p "$git_dir" "$cloud_dir" "$bin_dir"

  git -C "$root" init --bare origin.git >/dev/null
  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" remote add origin "$root/origin.git"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"
  git_commit "$git_dir" init
  git -C "$git_dir" push -u origin main >/dev/null
  local before_head
  before_head="$(git -C "$git_dir" rev-parse HEAD)"

  printf '# Vault Schema\n' > "$cloud_dir/SCHEMA.md"
  printf '# Index\n' > "$cloud_dir/index.md"
  printf 'duplicate\n' > "$cloud_dir/new-duplicate.md"

  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
if [ "$1" = "sync" ]; then
  src="$2"
  dst="$3"
  if [ "$src" = "stub:cloud/wiki" ]; then
    cp -R "$CLOUD_FIXTURE/." "$dst/"
    echo "Transferred: 1 / 1, 100%"
    exit 0
  fi
fi
exit 99
STUB
  chmod +x "$bin_dir/rclone"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "raw_dedup" ] && [ "$5" = "--summary" ]; then
  echo "errors: 1"
  echo "  raw_dedup: 1"
  exit 23
fi
exit 99
STUB
  chmod +x "$bin_dir/skillwiki"

  CLOUD_FIXTURE="$cloud_dir" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    WIKI_SNAPSHOT_LOG="$log_file" \
    WIKI_SNAPSHOT_LOCK="$lock_file" \
    WIKI_GIT_REPAIR_SCRIPT="$root/repair.sh" \
    WIKI_SNAPSHOT_SKILLWIKI_BIN="$bin_dir/skillwiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
  local rc=$?

  local after_head
  after_head="$(git -C "$git_dir" rev-parse HEAD)"
  assert_eq "raw_dedup guard exits nonzero" "$rc" "1"
  assert_eq "raw_dedup guard prevents snapshot commit" "$after_head" "$before_head"
  if grep -q "raw_dedup guard failed" "$log_file"; then
    printf "PASS: raw_dedup guard logs failure\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: raw_dedup guard did not log failure\n"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_raw_dedup_guard_blocks_commit

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
