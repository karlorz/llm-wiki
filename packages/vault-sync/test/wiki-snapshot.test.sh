#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-snapshot.sh.

set -u

SNAPSHOT_REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_UNDER_TEST="$SNAPSHOT_REPO_ROOT/packages/vault-sync/scripts/wiki-snapshot.sh"
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

assert_file_contains() {
  local label="$1" file="$2" needle="$3"
  if grep -q -- "$needle" "$file" 2>/dev/null; then
    printf "PASS: %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "FAIL: %s — missing '%s' in %s\n" "$label" "$needle" "$file"
    FAIL=$((FAIL + 1))
  fi
}

make_live_vault_fixture() {
  local root="$1"
  mkdir -p "$root/wiki" "$root/wiki/meta/log-events" "$root/wiki/projects"
  printf '# Vault Schema\n' > "$root/wiki/SCHEMA.md"
  printf '# Vault Index\n' > "$root/wiki/index.md"
  printf '# Vault Log\n' > "$root/wiki/log.md"
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
assert_contains "snapshot has delete-intent no-resurrect" "snapshot_apply_delete_intents"
assert_contains "snapshot sources delete-intent lib" "delete-intent.sh"
assert_contains "snapshot strips resurrected tombstone paths" "stripped resurrected path"

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

test_snapshot_live_materializes_with_built_cli_before_sync() {
  local root
  root="$(mktemp -d)"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  local out_file="$root/out.txt"
  local log_file="$root/wiki-snapshot.log"
  mkdir -p "$git_dir" "$bin_dir" "$root/home"
  make_live_vault_fixture "$root"
  : > "$root/rclone.calls"

  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"
  printf '# Log\n' > "$git_dir/log.md"
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
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
exec node "$SNAPSHOT_REPO_ROOT/packages/cli/dist/cli.js" "$@"
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
if [ "$1" = "lsf" ]; then
  printf 'SCHEMA.md\n'
  printf 'index.md\n'
  printf 'log.md\n'
  exit 0
fi
if [ "$1" = "sync" ]; then
  if grep -q 'Generated by `skillwiki index rebuild`' "$SNAPSHOT_LIVE_VAULT/index.md"; then
    printf 'projection-before-sync\n' >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
  else
    printf 'sync-before-projection\n' >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
  fi
  exit 1
fi
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/skillwiki" "$bin_dir/rclone"

  HOME="$root/home" \
    SNAPSHOT_REPO_ROOT="$SNAPSHOT_REPO_ROOT" \
    SNAPSHOT_TEST_ROOT="$root" \
    SNAPSHOT_LIVE_VAULT="$root/wiki" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOCK="$root/wiki-snapshot.lock" \
    WIKI_SNAPSHOT_LOG="$log_file" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >"$out_file" 2>&1
  local rc=$?

  if [ "$rc" -ne 0 ] \
      && grep -q '^projection-before-sync$' "$root/rclone.calls" \
      && ! grep -q '^sync-before-projection$' "$root/rclone.calls" \
      && grep -q 'OK projections materialize before snapshot sync' "$log_file"; then
    printf "PASS: snapshot real CLI materializes projections before rclone sync\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: snapshot real CLI projection order was not proved (rc=%s output=%s log=%s calls=%s)\n" \
      "$rc" \
      "$(tr '\n' ' ' < "$out_file" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$log_file" 2>/dev/null)" \
      "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_snapshot_live_materializes_with_built_cli_before_sync

test_snapshot_live_allows_bounded_direct_s3_note_not_in_git_before_sync() {
  local root
  root="$(mktemp -d)"
  make_live_vault_fixture "$root"
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
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
# Accept dual-path projection/migration args; no-op success for preflight fixtures.
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then exit 0; fi
if [ "$1" = "log" ] && [ "$2" = "migrate-legacy" ]; then exit 0; fi
exit 0
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/rclone" "$bin_dir/skillwiki"

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
  make_live_vault_fixture "$root"
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
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
# Accept dual-path projection/migration args; no-op success for preflight fixtures.
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then exit 0; fi
if [ "$1" = "log" ] && [ "$2" = "migrate-legacy" ]; then exit 0; fi
exit 0
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/rclone" "$bin_dir/skillwiki"

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
  make_live_vault_fixture "$root"
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
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
# Accept dual-path projection/migration args; no-op success for preflight fixtures.
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then exit 0; fi
if [ "$1" = "log" ] && [ "$2" = "migrate-legacy" ]; then exit 0; fi
exit 0
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/rclone" "$bin_dir/skillwiki"

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


test_dual_path_projection_uses_converge_vault_before_rclone() {
  local root
  root="$(mktemp -d)"
  make_live_vault_fixture "$root"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  local log_file="$root/wiki-snapshot.log"
  local lock_file="$root/wiki-snapshot.lock"
  mkdir -p "$git_dir" "$bin_dir"
  : > "$root/rclone.calls"
  : > "$root/skillwiki.calls"

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
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/skillwiki.calls"
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "migrate-legacy" ]; then
  exit 0
fi
exit 0
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
# Fail first sync so we only prove ordering/args, not full snapshot success.
exit 1
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/skillwiki" "$bin_dir/rclone"

  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOG="$log_file" \
    WIKI_SNAPSHOT_LOCK="$lock_file" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >/dev/null 2>&1

  assert_file_contains "dual-path projection targets live vault with converge-vault" \
    "$root/skillwiki.calls" \
    "projections materialize $root/wiki --write --converge-vault $git_dir"
  if ! grep -q 'log migrate-legacy' "$root/skillwiki.calls"; then
    printf "PASS: dual-path default skips legacy migration\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: dual-path default unexpectedly ran legacy migration\n"
    FAIL=$((FAIL + 1))
  fi
  if grep -q 'OK projections materialize before snapshot sync' "$log_file" \
      && [ -s "$root/rclone.calls" ]; then
    printf "PASS: dual-path projection runs before rclone sync\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: dual-path projection order not proved\n"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_dual_path_projection_uses_converge_vault_before_rclone

test_dual_path_migrate_legacy_flag() {
  local root
  root="$(mktemp -d)"
  make_live_vault_fixture "$root"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  local log_file="$root/wiki-snapshot.log"
  local lock_file="$root/wiki-snapshot.lock"
  mkdir -p "$git_dir" "$bin_dir"
  : > "$root/skillwiki.calls"

  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
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
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/skillwiki.calls"
exit 0
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/skillwiki" "$bin_dir/rclone"

  # Invalid flag value must fail closed before rclone.
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOG="$log_file" \
    WIKI_SNAPSHOT_LOCK="$lock_file" \
    WIKI_SNAPSHOT_MIGRATE_LEGACY=maybe \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >/dev/null 2>&1
  local bad_rc=$?
  assert_eq "invalid migrate-legacy flag exits nonzero" "$bad_rc" "1"
  if grep -q 'WIKI_SNAPSHOT_MIGRATE_LEGACY must be 0 or 1' "$log_file"; then
    printf "PASS: invalid migrate-legacy flag logs fail-closed\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: invalid migrate-legacy flag did not log fail-closed\n"
    FAIL=$((FAIL + 1))
  fi

  : > "$root/skillwiki.calls"
  : > "$log_file"
  SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$git_dir" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOG="$log_file" \
    WIKI_SNAPSHOT_LOCK="$lock_file" \
    WIKI_SNAPSHOT_MIGRATE_LEGACY=1 \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$bin_dir:$PATH" \
    "$SCRIPT_UNDER_TEST" >/dev/null 2>&1

  assert_file_contains "attended migrate-legacy uses dual-path args" \
    "$root/skillwiki.calls" \
    "log migrate-legacy $root/wiki --write --converge-vault $git_dir"
  assert_file_contains "projection still uses dual-path after migration" \
    "$root/skillwiki.calls" \
    "projections materialize $root/wiki --write --converge-vault $git_dir"
  # Migration must appear before projection in the call log.
  local mig_line proj_line
  mig_line="$(grep -n 'log migrate-legacy' "$root/skillwiki.calls" | head -1 | cut -d: -f1)"
  proj_line="$(grep -n 'projections materialize' "$root/skillwiki.calls" | head -1 | cut -d: -f1)"
  if [ -n "$mig_line" ] && [ -n "$proj_line" ] && [ "$mig_line" -lt "$proj_line" ]; then
    printf "PASS: legacy migration runs before projection\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: legacy migration order not proved (mig=%s proj=%s)\n" "$mig_line" "$proj_line"
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$root"
}

test_dual_path_migrate_legacy_flag

assert_contains "snapshot supports attended legacy migration flag" "WIKI_SNAPSHOT_MIGRATE_LEGACY"
assert_contains "snapshot passes converge-vault to projections" "--converge-vault"

make_delete_intent_snapshot_fixture() {
  local root="$1" tombstone_count="$2" remote_count="$3"
  local git_dir="$root/wiki-git"
  local bin_dir="$root/bin"
  local home_dir="$root/home"
  mkdir -p "$git_dir/meta/delete-intents" "$bin_dir" "$home_dir"
  make_live_vault_fixture "$root"
  printf '# Vault Schema\n' > "$git_dir/SCHEMA.md"
  printf '# Index\n' > "$git_dir/index.md"
  printf '# Log\n' > "$git_dir/log.md"
  : > "$root/remote.paths"
  : > "$root/rclone.calls"

  git -C "$root" init --bare origin.git >/dev/null
  git -C "$git_dir" init >/dev/null
  git -C "$git_dir" branch -M main
  git -C "$git_dir" remote add origin "$root/origin.git"

  local i rel slug
  i=1
  while [ "$i" -le "$tombstone_count" ]; do
    rel="raw/transcripts/tombstone-$(printf '%03d' "$i").md"
    slug="raw__transcripts__tombstone-$(printf '%03d' "$i").md.json"
    cat > "$git_dir/meta/delete-intents/$slug" <<EOF
{
  "schema": "vault-delete-intent/v1",
  "path": "$rel",
  "action": "remove",
  "created": "2026-07-23T00:00:00.000Z",
  "host": "test",
  "actor": "test",
  "source": "cli",
  "expires": null
}
EOF
    if [ "$i" -le "$remote_count" ]; then
      printf '%s\n' "$rel" >> "$root/remote.paths"
    fi
    i=$((i + 1))
  done
  git -C "$git_dir" add -A >/dev/null
  git -C "$git_dir" -c user.name=test -c user.email=test@test commit -m init >/dev/null
  git -C "$git_dir" push -u origin main >/dev/null
  git --git-dir="$root/origin.git" symbolic-ref HEAD refs/heads/main

  cat > "$bin_dir/uname" <<'STUB'
#!/bin/bash
printf 'Linux\n'
STUB
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then exit 0; fi
if [ "$1" = "lint" ]; then exit 0; fi
exit 0
STUB
  cat > "$bin_dir/rclone" <<'STUB'
#!/bin/bash
cmd="$1"
shift || true
printf '%s %s\n' "$cmd" "$*" >> "$SNAPSHOT_TEST_ROOT/rclone.calls"
case "$cmd" in
  lsf)
    if printf '%s\n' "$*" | grep -q -- '--recursive'; then
      if [ "${RCLONE_INVENTORY_FAIL:-0}" = "1" ]; then
        exit 9
      fi
      printf 'SCHEMA.md\nindex.md\nlog.md\n'
      cat "$SNAPSHOT_TEST_ROOT/remote.paths"
      exit 0
    fi
    if [ "${RCLONE_RECHECK_PRESENT:-0}" = "1" ]; then
      printf '%s\n' "${RCLONE_RECHECK_BASENAME:-tombstone-001.md}"
    fi
    exit 0
    ;;
  sync)
    if [ "${RCLONE_RESURRECT_FIRST:-0}" = "1" ]; then
      mkdir -p "$2/raw/transcripts"
      printf 'resurrected\n' > "$2/raw/transcripts/tombstone-001.md"
    fi
    exit 0
    ;;
  deletefile)
    rel="${1#stub:cloud/wiki/}"
    if [ "${RCLONE_FAIL_FIRST_DELETE:-0}" = "1" ] && [ ! -e "$SNAPSHOT_TEST_ROOT/failed-once" ]; then
      : > "$SNAPSHOT_TEST_ROOT/failed-once"
      exit 1
    fi
    if grep -Fxq "$rel" "$SNAPSHOT_TEST_ROOT/remote.paths"; then
      exit 0
    fi
    exit 1
    ;;
esac
exit 99
STUB
  chmod +x "$bin_dir/uname" "$bin_dir/flock" "$bin_dir/skillwiki" "$bin_dir/rclone"
}

run_delete_intent_snapshot_fixture() {
  local root="$1"
  HOME="$root/home" \
    SNAPSHOT_TEST_ROOT="$root" \
    WIKI_GIT_WORKTREE="$root/wiki-git" \
    WIKI_DIR="$root/wiki" \
    WIKI_SNAPSHOT_LOCK="$root/wiki-snapshot.lock" \
    WIKI_SNAPSHOT_LOG="$root/wiki-snapshot.log" \
    WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES="${WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES:-10}" \
    CLOUD_REMOTE="stub:cloud/wiki" \
    PATH="$root/bin:$PATH" \
    "$SCRIPT_UNDER_TEST" > "$root/out.txt" 2>&1
}

test_snapshot_skips_delete_calls_for_absent_remote_tombstones() {
  local root calls rc
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 12 0

  RCLONE_RESURRECT_FIRST=1 run_delete_intent_snapshot_fixture "$root"
  rc=$?
  calls="$(grep -c '^deletefile ' "$root/rclone.calls" 2>/dev/null || true)"

  if [ "$rc" -eq 0 ] \
      && [ "$calls" = "0" ] \
      && grep -q 'active=12 inventory_ready=1 remote_present=0 attempted=0 pruned=0 already_absent=12 failed=0 deferred=0' "$root/wiki-snapshot.log" \
      && [ ! -e "$root/wiki-git/raw/transcripts/tombstone-001.md" ]; then
    printf 'PASS: snapshot skips absent tombstone deletes and still strips resurrection\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: snapshot absent-tombstone behavior (rc=%s calls=%s log=%s output=%s)\n' \
      "$rc" "$calls" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$root/out.txt" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_bounds_attempts_when_first_delete_fails() {
  local root calls rc
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 12 12

  RCLONE_FAIL_FIRST_DELETE=1 \
    RCLONE_RECHECK_PRESENT=1 \
    RCLONE_RECHECK_BASENAME=tombstone-001.md \
    run_delete_intent_snapshot_fixture "$root"
  rc=$?
  calls="$(grep -c '^deletefile ' "$root/rclone.calls" 2>/dev/null || true)"

  if [ "$rc" -eq 0 ] \
      && [ "$calls" = "10" ] \
      && grep -q 'active=12 inventory_ready=1 remote_present=12 attempted=10 pruned=9 already_absent=0 failed=1 deferred=2' "$root/wiki-snapshot.log" \
      && ! grep -q 'direct-S3-not-git warning' "$root/out.txt"; then
    printf 'PASS: snapshot caps attempts even when a delete fails\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: snapshot attempt cap (rc=%s calls=%s log=%s output=%s)\n' \
      "$rc" "$calls" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$root/out.txt" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_prunes_only_remote_present_tombstones() {
  local root calls rc recursive_lists
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 5 3

  run_delete_intent_snapshot_fixture "$root"
  rc=$?
  calls="$(grep '^deletefile ' "$root/rclone.calls" 2>/dev/null || true)"
  recursive_lists="$(grep '^lsf ' "$root/rclone.calls" | grep -c -- '--recursive' || true)"

  if [ "$rc" -eq 0 ] \
      && [ "$(printf '%s\n' "$calls" | sed '/^$/d' | wc -l | tr -d ' ')" = "3" ] \
      && printf '%s\n' "$calls" | grep -q 'tombstone-001.md' \
      && printf '%s\n' "$calls" | grep -q 'tombstone-002.md' \
      && printf '%s\n' "$calls" | grep -q 'tombstone-003.md' \
      && ! printf '%s\n' "$calls" | grep -q 'tombstone-004.md' \
      && grep -q 'active=5 inventory_ready=1 remote_present=3 attempted=3 pruned=3 already_absent=2 failed=0 deferred=0' "$root/wiki-snapshot.log" \
      && [ "$recursive_lists" = "2" ]; then
    printf 'PASS: snapshot prunes only exact remote-present tombstones with two inventories\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: snapshot exact remote-present plan (rc=%s lists=%s calls=%s log=%s)\n' \
      "$rc" "$recursive_lists" "$(printf '%s' "$calls" | tr '\n' ';')" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_classifies_inventory_delete_race_as_absent() {
  local root calls rc
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 1 1

  RCLONE_FAIL_FIRST_DELETE=1 run_delete_intent_snapshot_fixture "$root"
  rc=$?
  calls="$(grep -c '^deletefile ' "$root/rclone.calls" 2>/dev/null || true)"

  if [ "$rc" -eq 0 ] \
      && [ "$calls" = "1" ] \
      && grep -q 'delete race resolved as already absent' "$root/wiki-snapshot.log" \
      && grep -q 'active=1 inventory_ready=1 remote_present=1 attempted=1 pruned=0 already_absent=1 failed=0 deferred=0' "$root/wiki-snapshot.log"; then
    printf 'PASS: snapshot classifies delete race with one exact read-only recheck\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: snapshot race classification (rc=%s calls=%s log=%s)\n' \
      "$rc" "$calls" "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_skips_optional_prune_when_inventory_fails() {
  local root calls rc
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 3 3

  RCLONE_INVENTORY_FAIL=1 run_delete_intent_snapshot_fixture "$root"
  rc=$?
  calls="$(grep -c '^deletefile ' "$root/rclone.calls" 2>/dev/null || true)"

  if [ "$rc" -eq 0 ] \
      && [ "$calls" = "0" ] \
      && grep -q 'remote inventory unavailable; optional S3 pruning skipped' "$root/wiki-snapshot.log" \
      && grep -q 'active=3 inventory_ready=0 remote_present=0 attempted=0 pruned=0 already_absent=0 failed=0 deferred=0' "$root/wiki-snapshot.log"; then
    printf 'PASS: snapshot fails closed on unknown remote inventory without weakening no-resurrect\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: snapshot inventory failure handling (rc=%s calls=%s log=%s output=%s)\n' \
      "$rc" "$calls" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$root/out.txt" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_direct_s3_warning_excludes_tombstone_but_keeps_unexplained_path() {
  local root rc
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 1 1
  printf 'raw/transcripts/unexplained.md\n' >> "$root/remote.paths"

  run_delete_intent_snapshot_fixture "$root"
  rc=$?

  if [ "$rc" -eq 0 ] \
      && grep -q 'direct-S3-not-git warning: 1 note path' "$root/out.txt" \
      && grep -q 'direct-S3-not-git: raw/transcripts/unexplained.md' "$root/out.txt" \
      && ! grep -q 'direct-S3-not-git: raw/transcripts/tombstone-001.md' "$root/out.txt"; then
    printf 'PASS: direct-S3 warning excludes tombstones and retains unexplained paths\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: direct-S3 tombstone exclusion (rc=%s output=%s)\n' \
      "$rc" "$(tr '\n' ' ' < "$root/out.txt" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_rejects_invalid_tombstone_prune_cap() {
  local root rc
  root="$(mktemp -d)"
  make_delete_intent_snapshot_fixture "$root" 1 1

  WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES=invalid run_delete_intent_snapshot_fixture "$root"
  rc=$?

  if [ "$rc" -ne 0 ] \
      && grep -q 'invalid WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES=invalid' "$root/wiki-snapshot.log" \
      && ! grep -q '^sync ' "$root/rclone.calls"; then
    printf 'PASS: snapshot rejects invalid tombstone prune cap before sync\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: invalid tombstone prune cap was not rejected (rc=%s calls=%s log=%s)\n' \
      "$rc" "$(tr '\n' ';' < "$root/rclone.calls" 2>/dev/null)" \
      "$(tr '\n' ' ' < "$root/wiki-snapshot.log" 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_snapshot_skips_delete_calls_for_absent_remote_tombstones
test_snapshot_bounds_attempts_when_first_delete_fails
test_snapshot_prunes_only_remote_present_tombstones
test_snapshot_classifies_inventory_delete_race_as_absent
test_snapshot_skips_optional_prune_when_inventory_fails
test_snapshot_direct_s3_warning_excludes_tombstone_but_keeps_unexplained_path
test_snapshot_rejects_invalid_tombstone_prune_cap

if [ "$(uname -s)" != "Linux" ]; then
  printf "SKIP: Linux-only runtime snapshot guard test\n"
  printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

git_commit() {
  local repo="$1" msg="$2"
  git -C "$repo" config user.name test
  git -C "$repo" config user.email test@test
  git -C "$repo" add -A >/dev/null
  git -C "$repo" -c user.name=test -c user.email=test@test commit -m "$msg" >/dev/null
}

test_raw_dedup_guard_blocks_commit() {
  local root
  root="$(mktemp -d)"
  make_live_vault_fixture "$root"
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
  git --git-dir="$root/origin.git" symbolic-ref HEAD refs/heads/main
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
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$bin_dir/rclone" "$bin_dir/flock"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/skillwiki.calls"
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then
  exit 0
fi
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "raw_dedup" ] && [ "$5" = "--summary" ]; then
  echo "errors: 1"
  echo "  raw_dedup: 1"
  exit 23
fi
exit 99
STUB
  chmod +x "$bin_dir/skillwiki"

  SNAPSHOT_TEST_ROOT="$root" \
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
  assert_file_contains "raw_dedup fixture owns projection command" "$root/skillwiki.calls" "^projections materialize "
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
  make_live_vault_fixture "$root"
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
  git --git-dir="$root/origin.git" symbolic-ref HEAD refs/heads/main
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
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$bin_dir/rclone" "$bin_dir/flock"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/skillwiki.calls"
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then
  exit 0
fi
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "raw_dedup" ] && [ "$5" = "--summary" ]; then
  echo "errors: 0"
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/skillwiki"

  SNAPSHOT_TEST_ROOT="$root" \
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
  assert_file_contains "conflict-marker fixture owns projection command" "$root/skillwiki.calls" "^projections materialize "
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
  make_live_vault_fixture "$root"
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
  git --git-dir="$root/origin.git" symbolic-ref HEAD refs/heads/main

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
  cat > "$bin_dir/flock" <<'STUB'
#!/bin/bash
exit 0
STUB
  chmod +x "$bin_dir/rclone" "$bin_dir/flock"

  cat > "$bin_dir/skillwiki" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$SNAPSHOT_TEST_ROOT/skillwiki.calls"
if [ "$1" = "projections" ] && [ "$2" = "materialize" ]; then
  exit 0
fi
if [ "$1" = "lint" ] && [ "$3" = "--only" ] && [ "$4" = "raw_dedup" ] && [ "$5" = "--summary" ]; then
  echo "errors: 0"
  exit 0
fi
exit 99
STUB
  chmod +x "$bin_dir/skillwiki"

  SNAPSHOT_TEST_ROOT="$root" \
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

  assert_file_contains "standalone-equals fixture owns projection command" "$root/skillwiki.calls" "^projections materialize "
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
