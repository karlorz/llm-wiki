#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
STATUS_SH="$SCRIPT_DIR/status.sh"

if [ ! -f "$STATUS_SH" ]; then
  echo "FAIL: missing status script at $STATUS_SH" >&2
  exit 1
fi

out_file="$(mktemp)"
set +e
bash "$STATUS_SH" --read-only --restart-jobs >"$out_file" 2>&1
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  cat "$out_file" >&2
  rm -f "$out_file"
  echo "FAIL: expected non-zero exit when --read-only blocks --restart-jobs" >&2
  exit 1
fi

if ! grep -q 'refuses state-changing action: restart-jobs' "$out_file"; then
  cat "$out_file" >&2
  rm -f "$out_file"
  echo "FAIL: expected explicit read-only refusal message" >&2
  exit 1
fi

rm -f "$out_file"
echo "PASS: --read-only refuses state-changing call (--restart-jobs)"

home_dir="$(mktemp -d)"
trap 'rm -rf "$home_dir"' EXIT

case "$(uname -s)" in
  Darwin)
    share_bin="$home_dir/Library/Application Support/vault-sync/bin"
    log_dir="$home_dir/Library/Logs"
    unit_dir="$home_dir/Library/LaunchAgents"
    mkdir -p "$share_bin" "$log_dir" "$unit_dir" "$home_dir/.config/rclone" "$home_dir/bin"
    touch "$unit_dir/com.karlchow.wiki-push.plist" "$unit_dir/com.karlchow.wiki-fetch.plist"
    ;;
  Linux)
    share_bin="$home_dir/.local/share/vault-sync/bin"
    log_dir="$home_dir/.local/state/vault-sync/log"
    unit_dir="$home_dir/.config/systemd/user"
    mkdir -p "$share_bin" "$log_dir" "$unit_dir" "$home_dir/.config/rclone" "$home_dir/bin"
    touch "$unit_dir/wiki-push.timer" "$unit_dir/wiki-fetch.timer"
    ;;
  *)
    echo "SKIP: unsupported OS for helper status test"
    exit 0
    ;;
esac

touch "$share_bin/wiki-push.sh"
chmod +x "$share_bin/wiki-push.sh"
printf '2026-06-10T00:00:00Z OK push (no changes)\n' > "$log_dir/wiki-push.log"
printf '2026-06-10T00:00:00Z OK behind=0 delta=0 (no notify)\n' > "$log_dir/wiki-fetch.log"
printf '%s\n' \
  '- remotely-save/data.json' \
  '- .skillwiki/sync.lock' \
  '- .skillwiki/memory/' \
  '- .skillwiki/memory-topics.json' \
  '- .claude/settings.local.json' > "$home_dir/.config/rclone/wiki-push-filters.txt"
ln -s "$home_dir/missing/wiki-sync.sh" "$home_dir/bin/wiki-sync.sh"

helper_out="$(mktemp)"
HOME="$home_dir" VS_READ_ONLY=1 VS_JSON=1 bash "$STATUS_SH" >"$helper_out"

if ! grep -q '"id":"vault_sync_presync_helper"' "$helper_out"; then
  cat "$helper_out" >&2
  rm -f "$helper_out"
  echo "FAIL: expected presync helper status check" >&2
  exit 1
fi

if ! grep -q '"status":"warn"' "$helper_out" || ! grep -q 'broken symlink' "$helper_out"; then
  cat "$helper_out" >&2
  rm -f "$helper_out"
  echo "FAIL: expected broken wiki-sync symlink warning" >&2
  exit 1
fi

rm -f "$helper_out"
echo "PASS: --read-only reports broken wiki-sync helper symlink"

snapshot_home="$(mktemp -d)"
case "$(uname -s)" in
  Darwin)
    snapshot_share="$snapshot_home/Library/Application Support/vault-sync/bin"
    ;;
  Linux)
    snapshot_share="$snapshot_home/.local/share/vault-sync/bin"
    mkdir -p "$snapshot_home/.config/systemd/user"
    touch "$snapshot_home/.config/systemd/user/wiki-snapshot.timer"
    ;;
  *)
    echo "SKIP: unsupported OS for snapshotter status test"
    exit 0
    ;;
esac

mkdir -p "$snapshot_share" "$snapshot_home/.skillwiki"
snapshot_script="$snapshot_share/wiki-snapshot.sh"
printf '%s\n' '#!/usr/bin/env bash' '# --max-delete 10' > "$snapshot_script"
chmod +x "$snapshot_script"
cat > "$snapshot_home/.skillwiki/.env" <<EOF
vault_sync.installed=true
vault_sync.role=snapshotter
vault_sync.service_scope=user
vault_sync.snapshot_script=$snapshot_script
EOF

snapshot_out="$(mktemp)"
HOME="$snapshot_home" VS_READ_ONLY=1 VS_JSON=1 bash "$STATUS_SH" >"$snapshot_out"

if grep -Eq 'Script missing: .*wiki-push|Filter missing: .*wiki-push-filters' "$snapshot_out"; then
  cat "$snapshot_out" >&2
  rm -f "$snapshot_out"
  echo "FAIL: snapshotter status should not require leaf wiki-push assets" >&2
  exit 1
fi

if ! grep -q '"id":"vault_sync_installed".*"status":"pass".*wiki-snapshot.sh' "$snapshot_out"; then
  cat "$snapshot_out" >&2
  rm -f "$snapshot_out"
  echo "FAIL: expected snapshotter install check to use wiki-snapshot.sh" >&2
  exit 1
fi

if ! grep -q '"id":"vault_sync_filter_present".*"status":"pass".*not applicable' "$snapshot_out"; then
  cat "$snapshot_out" >&2
  rm -f "$snapshot_out"
  echo "FAIL: expected snapshotter filter check to be not applicable" >&2
  exit 1
fi

rm -f "$snapshot_out"
rm -rf "$snapshot_home"
echo "PASS: --read-only snapshotter status skips leaf wiki-push assets"
