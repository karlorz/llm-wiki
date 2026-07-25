#!/usr/bin/env bash
# Shared fake systemctl for snapshot-health live-adapter tests (v0.10.15).
#
# Env:
#   FAKE_SYSTEMCTL_LOG      - request log path (scope\tunit\tProperty lines)
#   FAKE_SYSTEMCTL_PROFILE  - completed | failed | never-run | running |
#                             timer-no-next | stale | consecutive-failures |
#                             unavailable
#
# Refuses snake_case property names (underscores). Returns case-sensitive
# systemd property values for wiki-snapshot.timer / wiki-snapshot.service.
set -u

LOG="${FAKE_SYSTEMCTL_LOG:-/dev/null}"
PROFILE="${FAKE_SYSTEMCTL_PROFILE:-completed}"

args=("$@")
scope="system"
unit=""
prop=""
i=0
while [ $i -lt ${#args[@]} ]; do
  a="${args[$i]}"
  case "$a" in
    --user) scope="user" ;;
    show) ;;
    --property=*) prop="${a#--property=}" ;;
    --value) ;;
    wiki-snapshot.timer|wiki-snapshot.service) unit="$a" ;;
    *)
      if [ -z "$unit" ] && [[ "$a" == wiki-snapshot.* ]]; then
        unit="$a"
      fi
      ;;
  esac
  i=$((i + 1))
done

if [ -z "$prop" ]; then
  echo "fake-systemctl: missing --property" >&2
  exit 2
fi

# Refuse snake_case / fixture-style property names.
if [[ "$prop" == *_* ]]; then
  echo "REFUSED_SNAKE_CASE:$prop" >>"$LOG"
  echo "fake-systemctl: refused snake_case property '$prop'" >&2
  exit 3
fi

printf '%s\t%s\t%s\n' "$scope" "$unit" "$prop" >>"$LOG"

if [ "$PROFILE" = "unavailable" ]; then
  printf '\n'
  exit 0
fi

# Shared healthy timer baseline (all profiles except unavailable).
timer_value() {
  case "$1" in
    LoadState) printf 'loaded' ;;
    UnitFileState) printf 'enabled' ;;
    ActiveState) printf 'active' ;;
    SubState) printf 'waiting' ;;
    NextElapseUSecRealtime) printf '2026-07-25T12:32:00Z' ;;
    Result) printf 'success' ;;
  esac
}

service_value() {
  case "$PROFILE" in
    failed)
      case "$1" in
        LoadState) printf 'loaded' ;;
        ActiveState) printf 'failed' ;;
        SubState) printf 'failed' ;;
        Result) printf 'failed' ;;
        ExecMainStatus) printf '23' ;;
        ExecMainCode) printf '1' ;;
        InactiveEnterTimestamp) printf '2026-07-25T11:58:40Z' ;;
        ExecMainStartTimestamp) printf '2026-07-25T11:58:10Z' ;;
        ExecMainExitTimestamp) printf '2026-07-25T11:58:40Z' ;;
      esac
      ;;
    never-run)
      case "$1" in
        LoadState) printf 'loaded' ;;
        ActiveState) printf 'inactive' ;;
        SubState) printf 'dead' ;;
        Result) printf 'success' ;;
        ExecMainStatus) printf '0' ;;
        ExecMainCode) printf '0' ;;
      esac
      ;;
    running)
      case "$1" in
        LoadState) printf 'loaded' ;;
        ActiveState) printf 'active' ;;
        SubState) printf 'running' ;;
        Result) printf 'success' ;;
        ExecMainStatus) printf '0' ;;
        ExecMainCode) printf '0' ;;
        # ActiveEnterTimestamp empty — start comes from ExecMainStartTimestamp
        ExecMainStartTimestamp) printf '2026-07-25T11:59:30Z' ;;
      esac
      ;;
    completed|timer-no-next|stale|consecutive-failures|*)
      case "$1" in
        LoadState) printf 'loaded' ;;
        ActiveState) printf 'inactive' ;;
        SubState) printf 'dead' ;;
        Result) printf 'success' ;;
        ExecMainStatus) printf '0' ;;
        ExecMainCode) printf '1' ;;
        # Real oneshot: ActiveEnterTimestamp empty after completion.
        InactiveEnterTimestamp) printf '2026-07-25T11:33:40Z' ;;
        ExecMainStartTimestamp) printf '2026-07-25T11:32:10Z' ;;
        ExecMainExitTimestamp) printf '2026-07-25T11:33:40Z' ;;
      esac
      ;;
  esac
}

case "$unit" in
  wiki-snapshot.timer)
    if [ "$PROFILE" = "timer-no-next" ] && [ "$prop" = "NextElapseUSecRealtime" ]; then
      printf ''
    else
      timer_value "$prop"
    fi
    ;;
  wiki-snapshot.service) service_value "$prop" ;;
esac
printf '\n'
