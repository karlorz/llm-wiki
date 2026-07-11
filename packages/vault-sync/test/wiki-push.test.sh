#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-push.sh.
#
# wiki-push.sh is an S3 transport only — it runs rclone copy and never touches
# git (no commit, no push, no pull). Single-writer-git is enforced: only sg01's
# wiki-snapshot.sh pushes to GitHub. These tests assert the S3-push behavior
# and the guards (case-collision, path_too_long) that gate it.

set -u

SCRIPT_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-push.sh"
FILTER_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/filters/wiki-push-filters.txt"
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

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -Fq -- "$needle" "$file"; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — missing '%s'\n" "$label" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains "push filter excludes local logs directory" "$FILTER_UNDER_TEST" "- logs/"

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
  cp "$(dirname "$SCRIPT_UNDER_TEST")/lib/git-case.sh" "$script_dir/lib/git-case.sh"
  cp "$(dirname "$SCRIPT_UNDER_TEST")/lib/conflict-markers.sh" "$script_dir/lib/conflict-markers.sh"
  chmod +x "$script_dir/wiki-push.sh"
  printf '%s\n' "$script_dir"
}

write_stub_rclone() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
cmd="$1"
shift || true
if [ -n "${RCLONE_CALLED_FILE:-}" ]; then
  echo called > "$RCLONE_CALLED_FILE"
fi
if [ -n "${RCLONE_CALLS_FILE:-}" ]; then
  printf '%s %s\n' "$cmd" "$*" >> "$RCLONE_CALLS_FILE"
fi
if [ "$cmd" = "lsf" ] && [ -n "${RCLONE_LSF_FILE:-}" ] && [ -f "$RCLONE_LSF_FILE" ]; then
  cat "$RCLONE_LSF_FILE"
  exit 0
fi
echo "Transferred:   	    1 B / 1 B, 100%, 1 B/s, ETA 0s"
exit 0
STUB
  chmod +x "$bin_dir/rclone"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "path_too_long" ] && [ "$5" = "--fix" ]; then
  echo "path_too_long: 0"
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "lint-delta" ]; then
  echo '{"ok":true,"data":{"full_errors":0,"base_errors":0,"new_errors":0,"resolved_errors":0,"humanHint":"clean"}}'
  exit 0
fi
echo "unexpected skillwiki invocation: $*" >&2
exit 1
STUB
  chmod +x "$bin_dir/skillwiki"
}

test_dirty_local_files_trigger_rclone_copy() {
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
  local local_head
  local_head="$(git -C "$vault" rev-parse HEAD)"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "dirty local files trigger rclone copy" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  # wiki-push no longer pushes to git — local commit must not advance origin.
  local remote_head
  remote_head="$(git --git-dir="$root/origin.git" rev-parse refs/heads/main)"
  assert_eq "wiki-push does not push to origin" "$remote_head" "$local_head"
  rm -rf "$root"
}

test_git_remote_failure_does_not_block_s3_publish() {
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

  # Break the git remote — wiki-push must not care (it no longer touches git).
  rm -rf "$root/origin.git"

  printf 'local\n' > "$vault/local.md"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "git remote failure does not block S3 publish" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  rm -rf "$root"
}

test_pull_helper_not_invoked_by_push() {
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

  printf 'local dirty\n' > "$vault/note.md"

  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
echo called > "$HELPER_STATE_FILE"
exit 0
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  HELPER_STATE_FILE="$root/helper-state" \
    HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "pull helper is NOT invoked by wiki-push" "$(cat "$root/helper-state" 2>/dev/null || true)" ""
  rm -rf "$root"
}

test_sync_lock_is_pushed_to_s3_not_git() {
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
    RCLONE_CALLED_FILE="$root/rclone-called" \
    RCLONE_CALLS_FILE="$root/rclone.calls" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  # rclone copy is invoked (S3 push happens regardless of git state).
  assert_eq "rclone copy is invoked" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  # wiki-push no longer commits to git — sync.lock stays untracked.
  assert_eq "sync lock remains untracked" "$(git -C "$vault" ls-files .skillwiki/sync.lock)" ""
  rm -rf "$root"
}

test_archive_move_prunes_stale_remote_source_path_after_copy() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  mkdir -p "$home/.config/rclone" "$vault/raw/transcripts" "$vault/_archive/raw/transcripts"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  printf 'old\n' > "$vault/raw/transcripts/old.md"
  git_commit "$vault" "add old transcript"
  git -C "$vault" push origin main >/dev/null

  mv "$vault/raw/transcripts/old.md" "$vault/_archive/raw/transcripts/old.md"
  printf '%s\n%s\n' "raw/transcripts/old.md" "_archive/raw/transcripts/old.md" > "$root/remote-files.txt"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_LSF_FILE="$root/remote-files.txt" \
    RCLONE_CALLS_FILE="$root/rclone.calls" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  # rclone copy is invoked (archived file is published to S3).
  assert_eq "rclone copy runs after archive move" "$(test -f "$root/rclone.calls" && echo called || echo skipped)" "called"
  assert_file_contains "wiki-push prunes stale archived source path" "$root/rclone.calls" "deletefile stub:wiki/raw/transcripts/old.md"
  rm -rf "$root"
}

test_memory_cache_dirty_does_not_block_s3_push() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  mkdir -p "$home/.config/rclone" "$vault/.skillwiki/memory/llm-wiki"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  printf 'old-cache\n' > "$vault/.skillwiki/memory/llm-wiki/topics.json"
  git_commit "$vault" "track old memory cache"
  git -C "$vault" push origin main >/dev/null

  printf 'local\n' > "$vault/local.md"
  printf 'new-cache\n' > "$vault/.skillwiki/memory/llm-wiki/topics.json"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  # S3 push proceeds regardless of memory-cache dirty state (no git commit gate).
  assert_eq "memory cache dirty does not block S3 push" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  rm -rf "$root"
}

test_case_only_collision_blocks_publish() {
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

  local empty_blob
  empty_blob="$(git -C "$vault" hash-object -w --stdin </dev/null)"
  git -C "$vault" update-index --add --cacheinfo 100644 "$empty_blob" Case.md
  git -C "$vault" update-index --add --cacheinfo 100644 "$empty_blob" case.md

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "case-only collision blocks rclone publish" "$(test -f "$root/rclone-called" && echo called || echo skipped)" "skipped"
  if git --git-dir="$root/origin.git" cat-file -e main:Case.md 2>/dev/null || git --git-dir="$root/origin.git" cat-file -e main:case.md 2>/dev/null; then
    case_remote_state="present"
  else
    case_remote_state="absent"
  fi
  assert_eq "case-only collision is absent from remote" "$case_remote_state" "absent"
  rm -rf "$root"
}

test_long_path_fix_runs_before_rclone() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  mkdir -p "$bin_dir" "$home/.config/rclone"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "path_too_long" ] && [ "$5" = "--fix" ]; then
  echo fixed > "$SKILLWIKI_FIX_MARKER"
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "lint-delta" ]; then
  echo '{"ok":true,"data":{"full_errors":0,"base_errors":0,"new_errors":0,"resolved_errors":0,"humanHint":"clean"}}'
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/skillwiki"

  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
if [ "$(cat "$SKILLWIKI_FIX_MARKER" 2>/dev/null || true)" = "fixed" ]; then
  echo ok > "$RCLONE_STATE_FILE"
  echo "Transferred:   	    1 B / 1 B, 100%, 1 B/s, ETA 0s"
  exit 0
fi
echo missing-fix > "$RCLONE_STATE_FILE"
exit 9
STUB
  chmod +x "$bin_dir/rclone"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    SKILLWIKI_FIX_MARKER="$root/skillwiki-fix" \
    RCLONE_STATE_FILE="$root/rclone-state" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "long-path fix runs before rclone publish" "$(cat "$root/rclone-state" 2>/dev/null || true)" "ok"
  rm -rf "$root"
}

test_long_path_fix_failure_blocks_publish() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  mkdir -p "$bin_dir" "$home/.config/rclone"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "path_too_long" ] && [ "$5" = "--fix" ]; then
  echo failed
  exit 23
fi
if [ "$1" = "sync" ] && [ "$2" = "lint-delta" ]; then
  echo '{"ok":true,"data":{"full_errors":0,"base_errors":0,"new_errors":0,"resolved_errors":0,"humanHint":"clean"}}'
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/skillwiki"

  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
echo called > "$RCLONE_CALLED_FILE"
exit 0
STUB
  chmod +x "$bin_dir/rclone"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "long-path fix failure blocks rclone publish" "$(test -f "$root/rclone-called" && echo called || echo skipped)" "skipped"
  rm -rf "$root"
}

test_conflict_marker_blocks_s3_push() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  mkdir -p "$home/.config/rclone" "$home/Library/Logs"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  {
    printf '%s\n' '<<<<<<< HEAD'
    printf 'local\n'
    printf '%s\n' '======='
    printf 'remote\n'
    printf '%s\n' '>>>>>>> branch'
  } > "$vault/bad.md"

  local rc=0
  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLS_FILE="$root/rclone.calls" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1 || rc=$?

  assert_eq "push conflict marker guard exits nonzero" "$rc" "1"
  assert_eq "push conflict marker guard prevents rclone upload" "$(grep -c '^copy ' "$root/rclone.calls" 2>/dev/null || echo 0)" "0"
  assert_file_contains "push conflict marker guard logs refusal" "$home/Library/Logs/wiki-push.log" "FAIL conflict marker blocks present; refusing S3 push"
  rm -rf "$root"
}

test_standalone_equals_line_does_not_block_push() {
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

  printf '%s\n' 'some heading' '=======' 'more content' > "$vault/standalone.md"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    RCLONE_CALLS_FILE="$root/rclone.calls" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "standalone equals line does not block push" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  assert_eq "standalone equals line allows rclone copy" "$(grep -c '^copy ' "$root/rclone.calls" 2>/dev/null || echo 0)" "1"
  rm -rf "$root"
}


test_lint_delta_inherited_allows_s3_push() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  # Override skillwiki with inherited-only delta
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "path_too_long" ] && [ "$5" = "--fix" ]; then
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "lint-delta" ]; then
  echo '{"ok":true,"data":{"full_errors":5,"base_errors":5,"new_errors":0,"resolved_errors":0,"humanHint":"inherited"}}'
  exit 0
fi
exit 1
STUB
  chmod +x "$bin_dir/skillwiki"
  mkdir -p "$home/.config/rclone" "$home/Library/Logs"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  HOME="$home" WIKI_DIR="$vault" WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1
  rc=$?

  assert_eq "inherited lint debt allows push" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  assert_file_contains "logs full/base/new/resolved" "$home/Library/Logs/wiki-push.log" "LINT-DELTA full=5 base=5 new=0 resolved=0"
  rm -rf "$root"
}

test_lint_delta_new_errors_block_s3_push() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "path_too_long" ] && [ "$5" = "--fix" ]; then
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "lint-delta" ]; then
  echo '{"ok":true,"data":{"full_errors":2,"base_errors":1,"new_errors":1,"resolved_errors":0,"humanHint":"new"}}'
  exit 23
fi
exit 1
STUB
  chmod +x "$bin_dir/skillwiki"
  mkdir -p "$home/.config/rclone" "$home/Library/Logs"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  local rc=0
  HOME="$home" WIKI_DIR="$vault" WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1 || rc=$?

  assert_eq "new lint errors block push exit" "$rc" "1"
  assert_eq "new lint errors prevent rclone" "$(test -f "$root/rclone-called" && echo called || echo skipped)" "skipped"
  assert_file_contains "logs new_errors block" "$home/Library/Logs/wiki-push.log" "new_errors=1 blocks S3 push"
  rm -rf "$root"
}

test_lint_delta_malformed_blocks_s3_push() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "path_too_long" ] && [ "$5" = "--fix" ]; then
  exit 0
fi
if [ "$1" = "sync" ] && [ "$2" = "lint-delta" ]; then
  echo 'not-json-at-all'
  exit 0
fi
exit 1
STUB
  chmod +x "$bin_dir/skillwiki"
  mkdir -p "$home/.config/rclone" "$home/Library/Logs"
  printf '+ *\n' > "$home/.config/rclone/wiki-push-filters.txt"

  local rc=0
  HOME="$home" WIKI_DIR="$vault" WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1 || rc=$?

  assert_eq "malformed delta blocks push exit" "$rc" "1"
  assert_eq "malformed delta prevents rclone" "$(test -f "$root/rclone-called" && echo called || echo skipped)" "skipped"
  assert_file_contains "logs malformed refusal" "$home/Library/Logs/wiki-push.log" "lint-delta evidence missing or malformed"
  rm -rf "$root"
}

test_dirty_local_files_trigger_rclone_copy
test_git_remote_failure_does_not_block_s3_publish
test_pull_helper_not_invoked_by_push
test_sync_lock_is_pushed_to_s3_not_git
test_archive_move_prunes_stale_remote_source_path_after_copy
test_memory_cache_dirty_does_not_block_s3_push
test_case_only_collision_blocks_publish
test_long_path_fix_runs_before_rclone
test_long_path_fix_failure_blocks_publish
test_conflict_marker_blocks_s3_push
test_standalone_equals_line_does_not_block_push
test_lint_delta_inherited_allows_s3_push
test_lint_delta_new_errors_block_s3_push
test_lint_delta_malformed_blocks_s3_push

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
