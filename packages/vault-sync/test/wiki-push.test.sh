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
PLATFORM_UNDER_TEST="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/platform.sh"
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

wiki_push_log_file() {
  local home="$1"
  HOME="$home" bash -c '
    . "$1"
    platform_detect_os
    printf "%s/wiki-push.log\n" "$(platform_log_dir)"
  ' _ "$PLATFORM_UNDER_TEST"
}

# Same resolution as wiki_push_log_file, but with a hard-coded fallback that
# also tries the linux default path. Returns the first path that exists;
# echoes the resolved path so tests can assert on it.
test_push_log_file() {
  local home="$1"
  local log
  log="$(wiki_push_log_file "$home")"
  if [ -f "$log" ]; then
    printf '%s\n' "$log"
  else
    printf '%s\n' "$home/.local/state/vault-sync/log/wiki-push.log"
  fi
}

# Compute the platform-aware cache directory under a given $HOME. This is
# the directory wiki-push.sh uses for the dedup state file and the pause
# marker. Mirrors platform.sh: macos -> ~/Library/Caches/vault-sync,
# linux -> ~/.cache/vault-sync. We force linux here for cross-platform
# determinism in the test environment (the real production host picks the
# correct path via platform_detect_os, but the test asserts on absolute
# paths the test can resolve directly without sourcing the platform lib).
test_push_cache_dir() {
  local home="$1"
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s/Library/Caches/vault-sync\n' "$home"
  else
    printf '%s/.cache/vault-sync\n' "$home"
  fi
}

assert_file_contains "push filter excludes local logs directory" "$FILTER_UNDER_TEST" "- logs/"
assert_file_contains "push filter excludes managed-write coordination lock" \
  "$FILTER_UNDER_TEST" \
  "- .skillwiki/managed-write.lock"

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
  if [ -f "$(dirname "$SCRIPT_UNDER_TEST")/lib/delete-intent.sh" ]; then
    cp "$(dirname "$SCRIPT_UNDER_TEST")/lib/delete-intent.sh" "$script_dir/lib/delete-intent.sh"
  fi
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  local log_file
  log_file="$(wiki_push_log_file "$home")"
  mkdir -p "$home/.config/rclone" "$(dirname "$log_file")"
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  assert_file_contains "push conflict marker guard logs refusal" "$log_file" "FAIL conflict marker blocks present; refusing S3 push"
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

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
  local log_file
  log_file="$(wiki_push_log_file "$home")"
  mkdir -p "$home/.config/rclone" "$(dirname "$log_file")"
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  HOME="$home" WIKI_DIR="$vault" WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1
  rc=$?

  assert_eq "inherited lint debt allows push" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  assert_file_contains "logs full/base/new/resolved" "$log_file" "LINT-DELTA full=5 base=5 new=0 resolved=0"
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
  local log_file
  log_file="$(wiki_push_log_file "$home")"
  mkdir -p "$home/.config/rclone" "$(dirname "$log_file")"
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  local rc=0
  HOME="$home" WIKI_DIR="$vault" WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1 || rc=$?

  assert_eq "new lint errors block push exit" "$rc" "1"
  assert_eq "new lint errors prevent rclone" "$(test -f "$root/rclone-called" && echo called || echo skipped)" "skipped"
  assert_file_contains "logs new_errors block" "$log_file" "new_errors=1 blocks S3 push"
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
  local log_file
  log_file="$(wiki_push_log_file "$home")"
  mkdir -p "$home/.config/rclone" "$(dirname "$log_file")"
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  local rc=0
  HOME="$home" WIKI_DIR="$vault" WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1 || rc=$?

  assert_eq "malformed delta blocks push exit" "$rc" "1"
  assert_eq "malformed delta prevents rclone" "$(test -f "$root/rclone-called" && echo called || echo skipped)" "skipped"
  assert_file_contains "logs malformed refusal" "$log_file" "lint-delta evidence missing or malformed"
  rm -rf "$root"
}

test_dirty_local_files_trigger_rclone_copy
test_git_remote_failure_does_not_block_s3_publish
test_pull_helper_not_invoked_by_push
test_sync_lock_is_pushed_to_s3_not_git
test_tombstone_prunes_remote_path_after_copy() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local vault
  vault="$(make_repo "$root")"
  local script_dir
  script_dir="$(make_script_dir "$root")"
  local bin_dir="$root/bin"
  write_stub_rclone "$bin_dir"
  mkdir -p "$home/.config/rclone" "$vault/meta/delete-intents" "$vault/summaries"
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  # Path is gone locally but still on remote; tombstone marks intentional delete.
  printf '{\n  "schema": "vault-delete-intent/v1",\n  "path": "summaries/gone.md",\n  "action": "remove",\n  "created": "2026-07-14T00:00:00.000Z",\n  "host": "test",\n  "actor": "test",\n  "source": "cli",\n  "expires": null\n}\n' \
    > "$vault/meta/delete-intents/summaries__gone.md.json"
  printf 'summaries/gone.md\n' > "$root/remote-files.txt"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_LSF_FILE="$root/remote-files.txt" \
    RCLONE_CALLS_FILE="$root/rclone.calls" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  assert_eq "rclone copy runs with tombstone present" "$(test -f "$root/rclone.calls" && echo called || echo skipped)" "called"
  assert_file_contains "wiki-push prunes tombstoned remote path" "$root/rclone.calls" "deletefile stub:wiki/summaries/gone.md"
  rm -rf "$root"
}

test_archive_move_prunes_stale_remote_source_path_after_copy
test_tombstone_prunes_remote_path_after_copy
test_memory_cache_dirty_does_not_block_s3_push
test_case_only_collision_blocks_publish
test_long_path_fix_runs_before_rclone
test_long_path_fix_failure_blocks_publish
test_conflict_marker_blocks_s3_push
test_standalone_equals_line_does_not_block_push
test_lint_delta_inherited_allows_s3_push
test_lint_delta_new_errors_block_s3_push
test_lint_delta_malformed_blocks_s3_push

# ---------------------------------------------------------------------------
# P1 conflict-marker dedup (2026-08-12 design)
# Verifies: WIKI_PUSH_FAIL_DEDUP_COOLDOWN_SECONDS / WIKI_PUSH_FAIL_DEDUP_DISABLE
# env vars, push_dedup_cooldown_check() state-machine behavior, the
# .paused marker file as the cross-platform pause signal.
# ---------------------------------------------------------------------------

# (a) cold-path OK push is unchanged when no markers are present and no prior
# dedup state exists. The script should log "OK push" and not write a dedup
# state file or a pause marker.
test_p1_cold_path_ok_push_unchanged() {
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  printf 'local\n' > "$vault/local.md"

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  local pushed_log
  pushed_log="$(test_push_log_file "$home")"
  assert_eq "P1(a) cold-path rclone is called" "$(cat "$root/rclone-called" 2>/dev/null || true)" "called"
  if [ -f "$pushed_log" ]; then
    if grep -q 'OK push' "$pushed_log"; then
      printf "PASS: P1(a) cold-path OK push line is present\n"
      PASS=$((PASS + 1))
    else
      printf "FAIL: P1(a) cold-path OK push line is missing in %s\n" "$pushed_log"
      FAIL=$((FAIL + 1))
    fi
    if grep -q 'FAIL conflict marker' "$pushed_log"; then
      printf "FAIL: P1(a) cold-path must not log conflict-marker FAIL when no markers are present\n"
      FAIL=$((FAIL + 1))
    else
      printf "PASS: P1(a) cold-path does not log spurious conflict-marker FAIL\n"
      PASS=$((PASS + 1))
    fi
  else
    printf "FAIL: P1(a) could not locate wiki-push.log to inspect (tried %s)\n" "$pushed_log"
    FAIL=$((FAIL + 1))
  fi
  local cache_dir
  cache_dir="$(test_push_cache_dir "$home")"
  local state_file="$cache_dir/wiki-push-fail-dedup.state"
  if [ -f "$state_file" ]; then
    printf "FAIL: P1(a) dedup state file should not be created on a clean push\n"
    FAIL=$((FAIL + 1))
  else
    printf "PASS: P1(a) dedup state file is absent on a clean push\n"
    PASS=$((PASS + 1))
  fi
  local pause_marker="$cache_dir/wiki-push.paused"
  if [ -f "$pause_marker" ]; then
    printf "FAIL: P1(a) pause marker should not be created on a clean push\n"
    FAIL=$((FAIL + 1))
  else
    printf "PASS: P1(a) pause marker is absent on a clean push\n"
    PASS=$((PASS + 1))
  fi
  rm -rf "$root"
}

# (b) conflict markers present on first detection: one FAIL line + dedup
# state file created. rclone must NOT be called.
test_p1_first_detection_writes_state_and_one_fail() {
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  # Inject a real conflict-marker file into the working tree.
  cat > "$vault/conflict.md" <<'EOF'
hello
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
EOF
  # We need vault_sync_scan_conflict_markers to find this. It scans tracked +
  # untracked .md. The file is untracked; that is fine for the scan.

  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    RCLONE_CALLED_FILE="$root/rclone-called" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  local pushed_log
  pushed_log="$(test_push_log_file "$home")"
  if [ -f "$pushed_log" ] && grep -q 'FAIL conflict marker' "$pushed_log"; then
    printf "PASS: P1(b) first-detection FAIL conflict marker line is written\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(b) first-detection FAIL conflict marker line is missing (log=%s)\n" "$pushed_log"
    FAIL=$((FAIL + 1))
  fi
  local fail_count
  fail_count="$(grep -c 'FAIL conflict marker' "$pushed_log" 2>/dev/null || echo 0)"
  assert_eq "P1(b) exactly one FAIL conflict marker line on first detection" "$fail_count" "1"
  local cache_dir
  cache_dir="$(test_push_cache_dir "$home")"
  local state_file="$cache_dir/wiki-push-fail-dedup.state"
  if [ -f "$state_file" ]; then
    printf "PASS: P1(b) dedup state file is created on first detection\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(b) dedup state file is missing after first detection (cache_dir=%s)\n" "$cache_dir"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -f "$root/rclone-called" ]; then
    printf "PASS: P1(b) rclone is not called when conflict markers are present\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(b) rclone must not be called when conflict markers are present\n"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -f "$cache_dir/wiki-push.paused" ]; then
    printf "PASS: P1(b) pause marker is not written on first detection (cooldown not yet expired)\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(b) pause marker should not exist on first detection\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

# (c) cooldown active: a second invocation within the cooldown window must
# NOT log a duplicate FAIL line. The dedup state file persists.
test_p1_cooldown_active_suppresses_duplicate_fail() {
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  cat > "$vault/conflict.md" <<'EOF'
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
EOF

  # First invocation — establishes the dedup state.
  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  # Second invocation within the cooldown — should NOT log a duplicate.
  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  local pushed_log
  pushed_log="$(test_push_log_file "$home")"
  local fail_count
  fail_count="$(grep -c 'FAIL conflict marker' "$pushed_log" 2>/dev/null || echo 0)"
  assert_eq "P1(c) cooldown suppresses duplicate FAIL across two invocations" "$fail_count" "1"
  local cache_dir
  cache_dir="$(test_push_cache_dir "$home")"
  if [ -f "$cache_dir/wiki-push-fail-dedup.state" ]; then
    printf "PASS: P1(c) dedup state file persists across invocations in the same cooldown\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(c) dedup state file is missing after two invocations (cache_dir=%s)\n" "$cache_dir"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -f "$cache_dir/wiki-push.paused" ]; then
    printf "PASS: P1(c) pause marker is not written while cooldown is active\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(c) pause marker should not exist while cooldown is active\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

# (d) markers persist past the cooldown: a single "cooldown expired — pausing
# push" line is written, the .paused marker file is created. We force the
# cooldown to a 1-second window to keep the test fast.
test_p1_cooldown_expired_writes_pause_marker() {
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  cat > "$vault/conflict.md" <<'EOF'
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
EOF

  # First invocation with a 1-second cooldown.
  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    WIKI_PUSH_FAIL_DEDUP_COOLDOWN_SECONDS=1 \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  # Sleep just over the cooldown so the next invocation sees the state as
  # "expired" rather than "cooldown".
  sleep 2

  # Second invocation past the cooldown.
  HOME="$home" \
    WIKI_DIR="$vault" \
    WIKI_REMOTE="stub:wiki" \
    WIKI_PUSH_FAIL_DEDUP_COOLDOWN_SECONDS=1 \
    PATH="$bin_dir:$PATH" \
    "$script_dir/wiki-push.sh" >/dev/null 2>&1

  local pushed_log
  pushed_log="$(test_push_log_file "$home")"
  if grep -q 'cooldown expired — pausing push' "$pushed_log" 2>/dev/null; then
    printf "PASS: P1(d) cooldown expired line is logged when markers persist past the window\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(d) cooldown expired line is missing (log=%s)\n" "$pushed_log"
    FAIL=$((FAIL + 1))
  fi
  local pause_marker
  cache_dir="$(test_push_cache_dir "$home")"
  pause_marker="$cache_dir/wiki-push.paused"
  if [ -f "$pause_marker" ]; then
    printf "PASS: P1(d) pause marker file is written on cooldown expiry\n"
    PASS=$((PASS + 1))
    if grep -q 'conflict-markers-persist-past-cooldown' "$pause_marker"; then
      printf "PASS: P1(d) pause marker has the expected reason\n"
      PASS=$((PASS + 1))
    else
      printf "FAIL: P1(d) pause marker is missing the expected reason field\n"
      FAIL=$((FAIL + 1))
    fi
  else
    printf "FAIL: P1(d) pause marker file is missing after cooldown expiry (cache_dir=%s)\n" "$cache_dir"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

# (e) WIKI_PUSH_FAIL_DEDUP_DISABLE=1 bypasses the dedup entirely. Every
# invocation logs the FAIL line (legacy behavior).
test_p1_disable_env_var_bypasses_dedup() {
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
  printf '%s\n' '+ *' '- /index.md' '- /log.md' > "$home/.config/rclone/wiki-push-filters.txt"

  cat > "$vault/conflict.md" <<'EOF'
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> branch
EOF

  for i in 1 2 3; do
    HOME="$home" \
      WIKI_DIR="$vault" \
      WIKI_REMOTE="stub:wiki" \
      WIKI_PUSH_FAIL_DEDUP_DISABLE=1 \
      PATH="$bin_dir:$PATH" \
      "$script_dir/wiki-push.sh" >/dev/null 2>&1
  done

  local pushed_log
  pushed_log="$(test_push_log_file "$home")"
  local fail_count
  fail_count="$(grep -c 'FAIL conflict marker' "$pushed_log" 2>/dev/null || echo 0)"
  assert_eq "P1(e) dedup-disabled logs a FAIL on every invocation" "$fail_count" "3"
  local cache_dir
  cache_dir="$(test_push_cache_dir "$home")"
  if [ ! -f "$cache_dir/wiki-push-fail-dedup.state" ]; then
    printf "PASS: P1(e) dedup state file is not created when dedup is disabled\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(e) dedup state file should not exist when dedup is disabled\n"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -f "$cache_dir/wiki-push.paused" ]; then
    printf "PASS: P1(e) pause marker is not written when dedup is disabled (within test window)\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P1(e) pause marker should not exist when dedup is disabled\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_p1_cold_path_ok_push_unchanged
test_p1_first_detection_writes_state_and_one_fail
test_p1_cooldown_active_suppresses_duplicate_fail
test_p1_cooldown_expired_writes_pause_marker
test_p1_disable_env_var_bypasses_dedup

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
