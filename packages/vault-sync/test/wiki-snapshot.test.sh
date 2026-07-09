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
assert_contains "snapshot calls raw dedup guard before commit" "if ! raw_dedup_guard; then"
assert_contains "snapshot has conflict marker guard function" "conflict_marker_guard()"
assert_contains "snapshot calls conflict marker guard before commit" "if ! conflict_marker_guard; then"
assert_contains "snapshot gates post-repair path with conflict marker guard" "if ! raw_dedup_guard || ! conflict_marker_guard; then"

test_snapshot_dry_run_warns_on_direct_s3_note_not_in_git() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  mkdir -p "$git_dir/raw/transcripts" "$bin_dir"
  : > "$root/rclone.calls"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"
  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" add -A >/dev/null
  git -C "$git_dir" -c user.name=test -c user.email=test@test commit -m init >/dev/null

  cat > "$bin_dir/uname" <<'STUB'
#!/bin/bash
printf 'Linux\n'
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
if [ "$1" = "lsf" ]; then
  printf 'SCHEMA.md\n'
  printf 'index.md\n'
  printf 'raw/transcripts/new.md\n'
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/rclone"

  local out_file="$root/out.txt"
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" --dry-run >"$out_file" 2>&1
  local rc=$?

  if [ "$rc" -eq 0 ] && grep -q 'direct-S3-not-git warning' "$out_file" && grep -q 'raw/transcripts/new.md' "$out_file" && ! grep -q 'delete' "$root/rclone.calls"; then
    printf "PASS: snapshot dry-run warns on direct-S3 note missing from Git\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshot dry-run direct-S3 warning missing (rc=%s output=%s calls=%s)\n" "$rc" "$(tr '\n' ' ' < "$out_file" 2>/dev/null)" "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_snapshot_dry_run_warns_on_direct_s3_note_not_in_git

test_snapshot_preflight_refreshes_origin_main_ref_explicitly() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local publisher="$root/publisher"
  local bin_dir="$root/bin"
  mkdir -p "$git_dir/raw/transcripts" "$bin_dir"
  : > "$root/rclone.calls"

  git -C "$root" init --bare origin.git >/dev/null
  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" remote add origin "$root/origin.git"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"
  git -C "$git_dir" add -A >/dev/null
  git -C "$git_dir" -c user.name=test -c user.email=test@test commit -m init >/dev/null
  git -C "$git_dir" push -u origin main >/dev/null
  git -C "$git_dir" fetch origin main >/dev/null 2>&1

  # Simulate a minimal or damaged snapshot checkout where a plain
  # `git fetch origin main` updates FETCH_HEAD but not refs/remotes/origin/main.
  git -C "$git_dir" config --unset-all remote.origin.fetch || true

  git -C "$root" clone "$root/origin.git" "$publisher" >/dev/null 2>&1
  git -C "$publisher" checkout main >/dev/null 2>&1
  mkdir -p "$publisher/raw/transcripts"
  printf 'new note\n' > "$publisher/raw/transcripts/new.md"
  git -C "$publisher" add -A >/dev/null
  git -C "$publisher" -c user.name=test -c user.email=test@test commit -m add-note >/dev/null
  git -C "$publisher" push origin main >/dev/null

  cat > "$bin_dir/uname" <<'STUB'
#!/bin/bash
printf 'Linux\n'
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
if [ "$1" = "lsf" ]; then
  printf 'SCHEMA.md\n'
  printf 'index.md\n'
  printf 'raw/transcripts/new.md\n'
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/rclone"

  local out_file="$root/out.txt"
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" --dry-run >"$out_file" 2>&1
  local rc=$?

  local origin_has_new="no"
  if git -C "$git_dir" cat-file -e origin/main:raw/transcripts/new.md 2>/dev/null; then
    origin_has_new="yes"
  fi

  if [ "$rc" -eq 0 ] \
      && [ "$origin_has_new" = "yes" ] \
      && ! grep -q 'direct-S3-not-git warning' "$out_file"; then
    printf "PASS: snapshot preflight explicitly refreshes origin/main\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshot preflight did not refresh origin/main (rc=%s origin_has_new=%s output=%s calls=%s)\n" \
      "$rc" \
      "$origin_has_new" \
      "$(tr '\n' ' ' < "$out_file" 2>/dev/null)" \
      "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_snapshot_preflight_refreshes_origin_main_ref_explicitly

test_snapshot_live_allows_bounded_direct_s3_note_not_in_git_before_sync() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  mkdir -p "$git_dir/raw/transcripts" "$bin_dir"
  : > "$root/rclone.calls"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"

  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" add -A >/dev/null
  git -C "$git_dir" -c user.name=test -c user.email=test@test commit -m init >/dev/null

  cat > "$bin_dir/uname" <<'STUB'
#!/bin/bash
printf 'Linux\n'
STUB
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
if [ "$1" = "lsf" ]; then
  printf 'SCHEMA.md\n'
  printf 'index.md\n'
  printf 'raw/transcripts/new.md\n'
  exit 0
fi
if [ "$1" = "sync" ]; then
  printf 'unexpected sync\n'
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/rclone"

  local out_file="$root/out.txt"
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOCK="$root/wiki-snapshot.lock" \
    WIKI_SNAPSHOT_LOG="$root/wiki-snapshot.log" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >"$out_file" 2>&1
  local rc=$?

  if ! grep -q 'refusing live snapshot' "$out_file" "$root/wiki-snapshot.log" 2>/dev/null \
      && grep -q 'direct-S3-not-git warning' "$out_file" \
      && grep -q '^sync ' "$root/rclone.calls"; then
    printf "PASS: snapshot live allows bounded direct-S3 note before sync\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshot live did not allow bounded direct-S3 note before sync (rc=%s output=%s log=%s calls=%s)\n" \
      "$rc" \
      "$(tr '\n' ' ' < "$out_file" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)" \
      "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_snapshot_live_allows_bounded_direct_s3_note_not_in_git_before_sync

test_snapshot_live_blocks_when_direct_s3_note_count_exceeds_limit() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  mkdir -p "$git_dir/raw/transcripts" "$bin_dir"
  : > "$root/rclone.calls"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"

  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" add -A >/dev/null
  git -C "$git_dir" -c user.name=test -c user.email=test@test commit -m init >/dev/null

  cat > "$bin_dir/uname" <<'STUB'
#!/bin/bash
printf 'Linux\n'
STUB
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
if [ "$1" = "lsf" ]; then
  printf 'SCHEMA.md\n'
  printf 'index.md\n'
  printf 'raw/transcripts/new-a.md\n'
  printf 'raw/transcripts/new-b.md\n'
  exit 0
fi
if [ "$1" = "sync" ]; then
  printf 'unexpected sync\n'
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/rclone"

  local out_file="$root/out.txt"
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOCK="$root/wiki-snapshot.lock" \
    WIKI_SNAPSHOT_LOG="$root/wiki-snapshot.log" \
    WIKI_SNAPSHOT_MAX_S3_ONLY_NOTES=1 \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >"$out_file" 2>&1
  local rc=$?

  if [ "$rc" -ne 0 ] \
      && grep -q 'direct-S3-not-git count exceeds limit' "$root/wiki-snapshot.log" \
      && ! grep -q '^sync ' "$root/rclone.calls"; then
    printf "PASS: snapshot live blocks direct-S3 note count above limit\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshot live did not block direct-S3 note count above limit (rc=%s output=%s log=%s calls=%s)\n" \
      "$rc" \
      "$(tr '\n' ' ' < "$out_file" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)" \
      "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_snapshot_live_blocks_when_direct_s3_note_count_exceeds_limit

test_snapshot_live_allows_when_override_env_set() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  mkdir -p "$git_dir/raw/transcripts" "$bin_dir"
  : > "$root/rclone.calls"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"

  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" add -A >/dev/null
  git -C "$git_dir" -c user.name=test -c user.email=test@test commit -m init >/dev/null

  cat > "$bin_dir/uname" <<'STUB'
#!/bin/bash
printf 'Linux\n'
STUB
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  # rclone stub: lsf returns the S3-only note path; sync exits non-zero so the
  # script halts immediately after passing the preflight gate. This is enough
  # to confirm the override path was taken without exercising downstream git
  # repair logic in tests.
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
if [ "$1" = "lsf" ]; then
  printf 'SCHEMA.md\n'
  printf 'index.md\n'
  printf 'raw/transcripts/new.md\n'
  exit 0
fi
if [ "$1" = "sync" ]; then
  printf 'stub: refusing sync to halt test\n' >&2
  exit 1
fi
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/rclone"

  local out_file="$root/out.txt"
  local log_file="$root/wiki-snapshot.log"
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOCK="$root/wiki-snapshot.lock" \
    WIKI_SNAPSHOT_LOG="$log_file" \
    WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES=1 \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >"$out_file" 2>&1
  local rc=$?

  # Success criteria for the override path:
  #   - "refusing live snapshot" must NOT appear (gate did not block)
  #   - The override warning must appear in the log
  #   - rclone sync must have been attempted (proves we passed the gate)
  if ! grep -q 'refusing live snapshot' "$out_file" "$log_file" 2>/dev/null \
      && grep -q 'WIKI_SNAPSHOT_ALLOW_S3_ONLY_NOTES=1 allows this live snapshot' "$log_file" \
      && grep -q '^sync ' "$root/rclone.calls"; then
    printf "PASS: snapshot live override env allows snapshot past preflight gate (rc=%s)\n" "$rc"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshot live override did not pass gate (rc=%s output=%s log=%s calls=%s)\n" \
      "$rc" \
      "$(tr '\n' ' ' < "$out_file" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$log_file" 2>/dev/null)" \
      "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_snapshot_live_allows_when_override_env_set

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

test_conflict_marker_guard_blocks_commit() {
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
  {
    printf '<<<<<<< HEAD\n'
    printf 'ours\n'
    printf '=======\n'
    printf 'theirs\n'
    printf '>>>>>>> branch\n'
  } > "$cloud_dir/bad.md"

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
  echo "errors: 0"
  exit 0
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
  assert_eq "snapshot conflict marker guard exits nonzero" "$rc" "1"
  assert_eq "snapshot conflict marker guard prevents commit" "$after_head" "$before_head"
  if grep -q "conflict marker blocks found after cloud sync" "$log_file" \
      && grep -q "bad.md:" "$log_file"; then
    printf "PASS: conflict marker guard logs failure\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: conflict marker guard did not log expected failure\n"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_conflict_marker_guard_blocks_commit

test_conflict_marker_guard_allows_standalone_equals() {
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

  printf '# Vault Schema\n' > "$cloud_dir/SCHEMA.md"
  printf '# Index\n' > "$cloud_dir/index.md"
  printf 'section one\n=======\nsection two\n' > "$cloud_dir/ok.md"

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
  echo "errors: 0"
  exit 0
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

  if grep -q "conflict marker blocks found after cloud sync" "$log_file"; then
    printf "FAIL: conflict marker guard blocked standalone equals separator\n"
    FAIL=$((FAIL + 1))
  elif grep -q "conflict-marker guard passed" "$log_file"; then
    printf "PASS: conflict marker guard passes on standalone equals separator\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: conflict marker guard did not log pass (rc=%s log=%s)\n" \
      "$rc" "$(tr '\n' ' ' < "$log_file" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_conflict_marker_guard_allows_standalone_equals

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
