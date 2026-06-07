#!/bin/bash
# wiki-fetch-notify.sh — read-only awareness of remote wiki changes.
#
# Runs `git fetch` against origin and emits a notification only when
# NEW commits have arrived since the previous run. Replaces the old
# seaweedfs-bisync writer with a non-destructive poller.
#
# Safe to run concurrently with skillwiki sync — fetch only touches refs/objects.

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]:-$0}" )" && pwd )"
. "$SCRIPT_DIR/lib/platform.sh"
. "$SCRIPT_DIR/lib/lockfile.sh"
platform_detect_os

WIKI_DIR="${WIKI_DIR:-$HOME/wiki}"
BRANCH="${WIKI_BRANCH:-main}"
STATE_DIR="$(platform_cache_dir)/wiki-fetch"
STATE_FILE="$STATE_DIR/last-behind"
STALE_STATE_FILE="$STATE_DIR/last-stale-notify"
STALE_NOTIFY_AFTER_SECONDS="${WIKI_FETCH_STALE_NOTIFY_AFTER_SECONDS:-1800}"
LOG_FILE="$(platform_log_dir)/wiki-fetch.log"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"
}

# Guard: working tree present.
if [ ! -d "$WIKI_DIR/.git" ]; then
  log "ERROR: $WIKI_DIR is not a git repo"
  exit 0
fi

cd "$WIKI_DIR" || { log "ERROR: cd $WIKI_DIR failed"; exit 0; }

# Fetch only the target branch. --quiet keeps log noise low.
# Failure (offline, auth, etc.) is silent on the notification side.
if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "fetch failed (offline or auth) — skipping notify"
  exit 0
fi

# Compute behind count. If branch is missing on either side, exit clean.
if ! BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH" 2>>"$LOG_FILE"); then
  log "rev-list failed — origin/$BRANCH may not exist"
  exit 0
fi

LAST_BEHIND=0
if [ -f "$STATE_FILE" ]; then
  LAST_BEHIND=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
  # Sanitize: must be a non-negative integer.
  case "$LAST_BEHIND" in
    ''|*[!0-9]*) LAST_BEHIND=0 ;;
  esac
fi

printf '%s' "$BEHIND" >"$STATE_FILE"

DELTA=$(( BEHIND - LAST_BEHIND ))
NOW=$(date +%s)

LAST_STALE_NOTIFY=0
if [ -f "$STALE_STATE_FILE" ]; then
  LAST_STALE_NOTIFY=$(cat "$STALE_STATE_FILE" 2>/dev/null || echo 0)
  case "$LAST_STALE_NOTIFY" in
    ''|*[!0-9]*) LAST_STALE_NOTIFY=0 ;;
  esac
fi

case "$STALE_NOTIFY_AFTER_SECONDS" in
  ''|*[!0-9]*) STALE_NOTIFY_AFTER_SECONDS=1800 ;;
esac

if [ "$DELTA" -gt 0 ]; then
  # New commits arrived since last poll. Notify with delta and total.
  TITLE="wiki"
  if [ "$DELTA" -eq "$BEHIND" ]; then
    MSG="$DELTA new commit(s) on origin/$BRANCH"
  else
    MSG="$DELTA new ($BEHIND total behind) on origin/$BRANCH"
  fi
  platform_notify "$TITLE" "$MSG — run skillwiki sync"
  printf '%s' "$NOW" >"$STALE_STATE_FILE"
  log "NOTIFY behind=$BEHIND delta=$DELTA"
elif [ "$BEHIND" -gt 0 ] && [ $(( NOW - LAST_STALE_NOTIFY )) -ge "$STALE_NOTIFY_AFTER_SECONDS" ]; then
  TITLE="wiki"
  MSG="still $BEHIND commit(s) behind origin/$BRANCH"
  platform_notify "$TITLE" "$MSG — sync may be stuck"
  printf '%s' "$NOW" >"$STALE_STATE_FILE"
  log "NOTIFY stale behind=$BEHIND delta=$DELTA"
else
  if [ "$BEHIND" -eq 0 ]; then
    rm -f "$STALE_STATE_FILE" 2>/dev/null || true
  fi
  log "OK behind=$BEHIND delta=$DELTA (no notify)"
fi

exit 0
