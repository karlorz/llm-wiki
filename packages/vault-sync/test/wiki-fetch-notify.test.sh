#!/bin/bash
# Regression tests for packages/vault-sync/scripts/wiki-fetch-notify.sh.

set -u

SOURCE_SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/wiki-fetch-notify.sh"
PASS=0
FAIL=0

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
git clone "$remote" "$remote_work" >/dev/null
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

printf "\n=== Results: %d passed, %d failed ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
