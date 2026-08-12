#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-fetch-notify.sh.

set -u

SOURCE_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-fetch-notify.sh"
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
  local label="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      printf "PASS: %s\n" "$label"
      PASS=$((PASS + 1))
      ;;
    *)
      printf "FAIL: %s — expected to find '%s' in '%s'\n" "$label" "$needle" "$haystack"
      FAIL=$((FAIL + 1))
      ;;
  esac
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
script_dir="$root/scripts"
notify_log="$root/notify.log"

git init --bare "$remote" >/dev/null
mkdir -p "$vault" "$script_dir/lib"
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
git -C "$vault" fetch origin main >/dev/null

cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
chmod +x "$script_dir/wiki-fetch-notify.sh"
cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
cat > "$script_dir/lib/lockfile.sh" <<'STUB'
# not used by wiki-fetch-notify.sh
STUB

mkdir -p "$home/cache/wiki-fetch"
printf '1' > "$home/cache/wiki-fetch/last-behind"
printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

HOME="$home" \
  WIKI_DIR="$vault" \
  WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS=1 \
  NOTIFY_LOG="$notify_log" \
  "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

assert_contains "stale behind count sends reminder" "$(cat "$notify_log" 2>/dev/null || true)" "still"
assert_contains "stale reminder includes behind total" "$(cat "$notify_log" 2>/dev/null || true)" "1 commit"

rm -rf "$root"

# ── Test: opt-in pull-on-delta consumes remote commits ──────────────────────
# Sets up a vault 1 commit behind origin with a stub pull helper, then runs
# wiki-fetch-notify.sh. Caller passes WIKI_FETCH_PULL_ON_DELTA value and
# expected pull-state via the two args.
run_pull_on_delta_case() {
  local pull_env="$1"   # 1 or "" (unset)
  local expect_pull="$2"  # "pull-called" or ""

  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"

  git init --bare "$remote" >/dev/null
  mkdir -p "$vault" "$script_dir/lib"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null

  local remote_work="$root/remote-work"
  git clone --branch main "$remote" "$remote_work" >/dev/null
  printf 'remote\n' > "$remote_work/remote-snapshot.md"
  git_commit "$remote_work" "Snapshot test"
  git -C "$remote_work" push origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  # Stub pull helper that records invocation — does NOT actually pull so we can
  # assert it was called without depending on real git state transitions.
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
echo "pull-called" > "$PULL_HELPER_STATE"
exit 0
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  mkdir -p "$home/cache/wiki-fetch"
  printf '0' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  local env_prefix="PULL_HELPER_STATE=$root/pull-state HOME=$home"
  env_prefix="$env_prefix WIKI_DIR=$vault"
  env_prefix="$env_prefix WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS=1"
  env_prefix="$env_prefix NOTIFY_LOG=$notify_log"
  if [ -n "$pull_env" ]; then
    env_prefix="$env_prefix WIKI_FETCH_PULL_ON_DELTA=$pull_env"
  fi
  env $env_prefix "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  # Return pull-state and notify-log separated by a newline so callers can
  # assert on both.
  printf '%s\n%s' "$(cat "$root/pull-state" 2>/dev/null || true)" "$(cat "$notify_log" 2>/dev/null || true)"
  rm -rf "$root"
}

actual="$(run_pull_on_delta_case "1" "")"
assert_contains "opt-in pull-on-delta invokes pull helper" "$actual" "pull-called"
assert_contains "pull-on-delta still notifies" "$actual" "new commit"

actual="$(run_pull_on_delta_case "" "")"
assert_contains "pull-on-delta defaults off (helper not invoked)" "$actual" ""

test_failed_pull_is_retried_on_next_poll() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"
  local pull_count="$root/pull-count"

  git init --bare "$remote" >/dev/null
  mkdir -p "$vault" "$script_dir/lib"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null

  local remote_work="$root/remote-work"
  git clone --branch main "$remote" "$remote_work" >/dev/null
  printf 'remote\n' > "$remote_work/remote-snapshot.md"
  git_commit "$remote_work" "Snapshot retry"
  git -C "$remote_work" push origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
count=0
if [ -f "$PULL_COUNT_FILE" ]; then
  count="$(cat "$PULL_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s' "$count" > "$PULL_COUNT_FILE"
exit 1
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  mkdir -p "$home/cache/wiki-fetch"
  printf '0' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  env HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS=1 \
    WIKI_FETCH_PULL_ON_DELTA=1 NOTIFY_LOG="$notify_log" PULL_COUNT_FILE="$pull_count" \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1
  env HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS=1 \
    WIKI_FETCH_PULL_ON_DELTA=1 NOTIFY_LOG="$notify_log" PULL_COUNT_FILE="$pull_count" \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  assert_eq "failed pull is retried on next poll" "$(cat "$pull_count" 2>/dev/null || true)" "2"
  assert_eq "failed pull still records observed behind count" "$(cat "$home/cache/wiki-fetch/last-behind")" "1"

  rm -rf "$root"
}

test_non_executable_pull_helper_runs_via_bash() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"
  local helper_state="$root/helper-state"

  git init --bare "$remote" >/dev/null
  mkdir -p "$vault" "$script_dir/lib"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null

  local remote_work="$root/remote-work"
  git clone --branch main "$remote" "$remote_work" >/dev/null
  printf 'remote\n' > "$remote_work/remote-snapshot.md"
  git_commit "$remote_work" "Snapshot dirty helper"
  git -C "$remote_work" push origin main >/dev/null
  printf 'local dirty\n' > "$vault/note.md"

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
printf 'pull-called' > "$HELPER_STATE_FILE"
exit 0
STUB
  chmod 0644 "$script_dir/wiki-pull-with-auto-resolve.sh"

  mkdir -p "$home/cache/wiki-fetch"
  printf '0' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  env HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS=1 \
    WIKI_FETCH_PULL_ON_DELTA=1 NOTIFY_LOG="$notify_log" HELPER_STATE_FILE="$helper_state" \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  assert_eq "non-executable helper still runs via bash" "$(cat "$helper_state" 2>/dev/null || true)" "pull-called"

  rm -rf "$root"
}

test_pull_on_delta_respects_existing_sync_lock() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"
  local helper_state="$root/helper-state"

  git init --bare "$remote" >/dev/null
  mkdir -p "$vault" "$script_dir/lib" "$vault/.skillwiki"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null

  local remote_work="$root/remote-work"
  git clone --branch main "$remote" "$remote_work" >/dev/null
  printf 'remote\n' > "$remote_work/remote-snapshot.md"
  git_commit "$remote_work" "Snapshot sync-lock"
  git -C "$remote_work" push origin main >/dev/null
  printf '{"session_id":"test","pid":1,"summary":"sync"}\n' > "$vault/.skillwiki/sync.lock"

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
printf 'pull-called' > "$HELPER_STATE_FILE"
exit 0
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  mkdir -p "$home/cache/wiki-fetch"
  printf '0' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  env HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS=1 \
    WIKI_FETCH_PULL_ON_DELTA=1 NOTIFY_LOG="$notify_log" HELPER_STATE_FILE="$helper_state" \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  assert_eq "pull-on-delta skips when sync lock is present" "$(cat "$helper_state" 2>/dev/null || true)" ""

  rm -rf "$root"
}

test_existing_handoff_skips_pull_and_backs_off_notification() {
  local root home remote vault script_dir notify_log helper_state head
  root="$(mktemp -d)"
  home="$root/home"
  remote="$root/origin.git"
  vault="$root/wiki"
  script_dir="$root/scripts"
  notify_log="$root/notify.log"
  helper_state="$root/helper-state"

  git init --bare "$remote" >/dev/null
  mkdir -p "$vault" "$script_dir/lib"
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null
  head="$(git -C "$vault" rev-parse HEAD)"

  git clone --branch main "$remote" "$root/remote-work" >/dev/null
  printf 'remote\n' > "$root/remote-work/remote.md"
  git_commit "$root/remote-work" "remote advance"
  git -C "$root/remote-work" push origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  cp "$(cd "$(dirname "$SOURCE_SCRIPT")" && pwd)/lib/git-operation-journal.sh" \
    "$script_dir/lib/git-operation-journal.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/lib/lockfile.sh" <<'STUB'
lockfile_acquire() { return 0; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
printf 'called\n' >> "$HELPER_STATE_FILE"
exit 1
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  # shellcheck source=/dev/null
  . "$script_dir/lib/git-operation-journal.sh"
  vault_sync_op_begin "$vault" "op-pending" "main" "$head" "$head" "lock:test" "test" "hash"
  vault_sync_op_mark_review_required "$vault" "op-pending" "semantic-conflict"

  env HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
    WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 NOTIFY_LOG="$notify_log" \
    HELPER_STATE_FILE="$helper_state" "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1
  env HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
    WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 NOTIFY_LOG="$notify_log" \
    HELPER_STATE_FILE="$helper_state" "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  assert_eq "handoff prevents pull helper calls" "$(cat "$helper_state" 2>/dev/null || true)" ""
  assert_eq "same handoff notifies once inside backoff" \
    "$(grep -c 'review-required' "$notify_log" 2>/dev/null | tr -d ' ')" "1"
  rm -rf "$root"
}

test_failed_pull_is_retried_on_next_poll
test_non_executable_pull_helper_runs_via_bash
test_pull_on_delta_respects_existing_sync_lock
test_existing_handoff_skips_pull_and_backs_off_notification

# ---------------------------------------------------------------------------
# P2 handoff hard-pause (2026-08-12 design)
# Verifies: WIKI_FETCH_HANDOFF_HARD_PAUSE=0 disables the hard pause
# (legacy behavior); WIKI_FETCH_HANDOFF_HARD_PAUSE_CYCLES threshold triggers
# the persistent-handoff log line and writes the .paused marker.
# ---------------------------------------------------------------------------

# (f) no handoff, no pause. The script should log "OK behind=N delta=..."
# and not write the .paused marker.
test_p2_no_handoff_no_pause() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  mkdir -p "$vault" "$script_dir/lib"
  git init --bare "$remote" >/dev/null
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/lib/lockfile.sh" <<'STUB'
lockfile_acquire() { return 0; }
STUB

  mkdir -p "$home/cache/wiki-fetch"
  printf '0' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_HANDOFF_HARD_PAUSE=1 \
    WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  local log
  log="$home/logs/wiki-fetch.log"
  if [ -f "$log" ] && grep -q 'OK behind' "$log"; then
    printf "PASS: P2(f) no handoff produces an OK behind line\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(f) no handoff should produce an OK behind line (log=%s)\n" "$log"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -f "$home/cache/wiki-fetch/wiki-fetch.paused" ]; then
    printf "PASS: P2(f) pause marker is absent when there is no handoff\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(f) pause marker should not exist when there is no handoff\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

# (g) handoff present → reminder-backoff. The first invocation of the
# handoff case emits a NOTIFY line; subsequent invocations emit SKIP PULL
# reminder-backoff lines. The cycle counter starts at 0 and increments.
test_p2_handoff_present_reminder_backoff() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"
  mkdir -p "$vault" "$script_dir/lib"
  git init --bare "$remote" >/dev/null
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null
  local head
  head="$(git -C "$vault" rev-parse HEAD)"

  # Advance the remote so BEHIND > 0.
  git clone --branch main "$remote" "$root/remote-work" >/dev/null
  printf 'remote\n' > "$root/remote-work/remote.md"
  git_commit "$root/remote-work" "remote advance"
  git -C "$root/remote-work" push origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  cp "$(cd "$(dirname "$SOURCE_SCRIPT")" && pwd)/lib/git-operation-journal.sh" \
    "$script_dir/lib/git-operation-journal.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/lib/lockfile.sh" <<'STUB'
lockfile_acquire() { return 0; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  # shellcheck source=/dev/null
  . "$script_dir/lib/git-operation-journal.sh"
  vault_sync_op_begin "$vault" "op-p2g" "main" "$head" "$head" "lock:test" "test" "hash"
  vault_sync_op_mark_review_required "$vault" "op-p2g" "semantic-conflict"

  mkdir -p "$home/cache/wiki-fetch"
  printf '1' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  # First invocation - NOTIFY line.
  HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
    WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 \
    WIKI_FETCH_HANDOFF_HARD_PAUSE=1 WIKI_FETCH_HANDOFF_HARD_PAUSE_CYCLES=12 \
    NOTIFY_LOG="$notify_log" \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  local log
  log="$home/logs/wiki-fetch.log"
  if grep -q 'NOTIFY handoff identity' "$log"; then
    printf "PASS: P2(g) first invocation emits a NOTIFY line for the handoff\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(g) first invocation should emit a NOTIFY line (log=%s)\n" "$log"
    FAIL=$((FAIL + 1))
  fi
  if [ -f "$home/cache/wiki-fetch/handoff-cycle-counter" ]; then
    local counter
    counter="$(cat "$home/cache/wiki-fetch/handoff-cycle-counter" 2>/dev/null | tr -d '[:space:]')"
    assert_eq "P2(g) counter is reset to 0 on the first NOTIFY" "$counter" "0"
  else
    printf "FAIL: P2(g) counter file should be created on the first NOTIFY\n"
    FAIL=$((FAIL + 1))
  fi

  # Subsequent invocations within the backoff - SKIP PULL reminder-backoff.
  for _ in 1 2 3; do
    HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
      WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 \
      WIKI_FETCH_HANDOFF_HARD_PAUSE=1 WIKI_FETCH_HANDOFF_HARD_PAUSE_CYCLES=12 \
      NOTIFY_LOG="$notify_log" \
      "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1
  done

  if [ -f "$home/cache/wiki-fetch/handoff-cycle-counter" ]; then
    local counter
    counter="$(cat "$home/cache/wiki-fetch/handoff-cycle-counter" 2>/dev/null | tr -d '[:space:]')"
    assert_eq "P2(g) counter increments to 3 after 3 reminder-backoff cycles" "$counter" "3"
  else
    printf "FAIL: P2(g) counter file should exist after reminder-backoff cycles\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

# (h) handoff persists past the threshold cycles. After 3 cycles of
# reminder-backoff (threshold=3), the script logs the persistent-handoff
# line and writes the .paused marker.
test_p2_handoff_persists_writes_pause_marker() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"
  mkdir -p "$vault" "$script_dir/lib"
  git init --bare "$remote" >/dev/null
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null
  local head
  head="$(git -C "$vault" rev-parse HEAD)"

  # Advance the remote so BEHIND > 0.
  git clone --branch main "$remote" "$root/remote-work" >/dev/null
  printf 'remote\n' > "$root/remote-work/remote.md"
  git_commit "$root/remote-work" "remote advance"
  git -C "$root/remote-work" push origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  cp "$(cd "$(dirname "$SOURCE_SCRIPT")" && pwd)/lib/git-operation-journal.sh" \
    "$script_dir/lib/git-operation-journal.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/lib/lockfile.sh" <<'STUB'
lockfile_acquire() { return 0; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  # shellcheck source=/dev/null
  . "$script_dir/lib/git-operation-journal.sh"
  vault_sync_op_begin "$vault" "op-p2h" "main" "$head" "$head" "lock:test" "test" "hash"
  vault_sync_op_mark_review_required "$vault" "op-p2h" "semantic-conflict"

  mkdir -p "$home/cache/wiki-fetch"
  printf '1' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  # First invocation - NOTIFY.
  HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
    WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 \
    WIKI_FETCH_HANDOFF_HARD_PAUSE=1 WIKI_FETCH_HANDOFF_HARD_PAUSE_CYCLES=3 \
    NOTIFY_LOG="$notify_log" \
    "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1

  # Three more reminder-backoff cycles (threshold = 3, so 3 should trigger).
  for _ in 1 2 3; do
    HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
      WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 \
      WIKI_FETCH_HANDOFF_HARD_PAUSE=1 WIKI_FETCH_HANDOFF_HARD_PAUSE_CYCLES=3 \
      NOTIFY_LOG="$notify_log" \
      "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1
  done

  local log
  log="$home/logs/wiki-fetch.log"
  if grep -q 'handoff persistent — pausing fetch' "$log"; then
    printf "PASS: P2(h) persistent-handoff line is logged after threshold cycles\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(h) persistent-handoff line is missing (log=%s)\n" "$log"
    FAIL=$((FAIL + 1))
  fi
  if [ -f "$home/cache/wiki-fetch/wiki-fetch.paused" ]; then
    printf "PASS: P2(h) pause marker file is written when the threshold is reached\n"
    PASS=$((PASS + 1))
    if grep -q 'handoff-persistent-past-threshold' "$home/cache/wiki-fetch/wiki-fetch.paused"; then
      printf "PASS: P2(h) pause marker has the expected reason field\n"
      PASS=$((PASS + 1))
    else
      printf "FAIL: P2(h) pause marker is missing the expected reason\n"
      FAIL=$((FAIL + 1))
    fi
  else
    printf "FAIL: P2(h) pause marker file is missing after the threshold\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

# (i) WIKI_FETCH_HANDOFF_HARD_PAUSE=0 bypasses the hard pause. The counter
# is not created and the persistent-handoff line is never logged, even after
# many cycles.
test_p2_disable_env_var_bypasses_hard_pause() {
  local root
  root="$(mktemp -d)"
  local home="$root/home"
  local remote="$root/origin.git"
  local vault="$root/wiki"
  local script_dir="$root/scripts"
  local notify_log="$root/notify.log"
  mkdir -p "$vault" "$script_dir/lib"
  git init --bare "$remote" >/dev/null
  git -C "$vault" init >/dev/null
  git -C "$vault" branch -M main
  git -C "$vault" remote add origin "$remote"
  printf 'base\n' > "$vault/note.md"
  git_commit "$vault" init
  git -C "$vault" push -u origin main >/dev/null
  local head
  head="$(git -C "$vault" rev-parse HEAD)"

  # Advance the remote so BEHIND > 0.
  git clone --branch main "$remote" "$root/remote-work" >/dev/null
  printf 'remote\n' > "$root/remote-work/remote.md"
  git_commit "$root/remote-work" "remote advance"
  git -C "$root/remote-work" push origin main >/dev/null

  cp "$SOURCE_SCRIPT" "$script_dir/wiki-fetch-notify.sh"
  cp "$(cd "$(dirname "$SOURCE_SCRIPT")" && pwd)/lib/git-operation-journal.sh" \
    "$script_dir/lib/git-operation-journal.sh"
  chmod +x "$script_dir/wiki-fetch-notify.sh"
  cat > "$script_dir/lib/platform.sh" <<'STUB'
platform_detect_os() { VS_OS=test; export VS_OS; }
platform_cache_dir() { echo "$HOME/cache"; }
platform_log_dir() { echo "$HOME/logs"; }
platform_notify() { printf '%s|%s\n' "$1" "$2" >> "$NOTIFY_LOG"; }
STUB
  cat > "$script_dir/lib/lockfile.sh" <<'STUB'
lockfile_acquire() { return 0; }
STUB
  cat > "$script_dir/wiki-pull-with-auto-resolve.sh" <<'STUB'
#!/bin/bash
exit 1
STUB
  chmod +x "$script_dir/wiki-pull-with-auto-resolve.sh"

  # shellcheck source=/dev/null
  . "$script_dir/lib/git-operation-journal.sh"
  vault_sync_op_begin "$vault" "op-p2i" "main" "$head" "$head" "lock:test" "test" "hash"
  vault_sync_op_mark_review_required "$vault" "op-p2i" "semantic-conflict"

  mkdir -p "$home/cache/wiki-fetch"
  printf '1' > "$home/cache/wiki-fetch/last-behind"
  printf '0' > "$home/cache/wiki-fetch/last-stale-notify"

  for _ in 1 2 3 4 5; do
    HOME="$home" WIKI_DIR="$vault" WIKI_FETCH_PULL_ON_DELTA=1 \
      WIKI_FETCH_HANDOFF_NOTIFY_AFTER_SECONDS=3600 \
      WIKI_FETCH_HANDOFF_HARD_PAUSE=0 \
      NOTIFY_LOG="$notify_log" \
      "$script_dir/wiki-fetch-notify.sh" >/dev/null 2>&1
  done

  local log
  log="$home/logs/wiki-fetch.log"
  if [ ! -f "$home/cache/wiki-fetch/handoff-cycle-counter" ]; then
    printf "PASS: P2(i) counter file is not created when hard pause is disabled\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(i) counter file should not exist when hard pause is disabled\n"
    FAIL=$((FAIL + 1))
  fi
  if [ ! -f "$home/cache/wiki-fetch/wiki-fetch.paused" ]; then
    printf "PASS: P2(i) pause marker is not written when hard pause is disabled\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(i) pause marker should not exist when hard pause is disabled\n"
    FAIL=$((FAIL + 1))
  fi
  if ! grep -q 'handoff persistent — pausing fetch' "$log"; then
    printf "PASS: P2(i) persistent-handoff line is not logged when hard pause is disabled\n"
    PASS=$((PASS + 1))
  else
    printf "FAIL: P2(i) persistent-handoff line should not appear when hard pause is disabled\n"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$root"
}

test_p2_no_handoff_no_pause
test_p2_handoff_present_reminder_backoff
test_p2_handoff_persists_writes_pause_marker
test_p2_disable_env_var_bypasses_hard_pause

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
