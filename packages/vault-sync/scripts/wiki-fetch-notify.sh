#!/bin/bash
# wiki-fetch-notify.sh — polls origin for remote wiki changes and notifies.
#
# Runs `git fetch` against origin and emits a notification only when
# NEW commits have arrived since the previous run. Replaces the old
# seaweedfs-bisync writer with a non-destructive poller.
#
# Opt-in WIKI_FETCH_PULL_ON_DELTA=1: on positive delta, also runs
# `git pull --rebase` (via wiki-pull-with-auto-resolve.sh) so the local
# working tree consumes sg01 Snapshot commits automatically. This is a
# mutating action — when enabled, this script is no longer a pure reader.
#
# When pull is disabled (default), this script is read-only: fetch only
# touches refs/objects and is safe to run concurrently with skillwiki sync.

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
# Opt-in: when enabled, a positive delta triggers `git pull --rebase` so the
# local working tree consumes sg01 Snapshot commits automatically. This
# replaces the git pull that was previously bundled inside wiki-push.sh's
# removed git-push block. Default off — set WIKI_FETCH_PULL_ON_DELTA=1 to
# enable on leaf hosts that want automated pull.
PULL_ON_DELTA="${WIKI_FETCH_PULL_ON_DELTA:-0}"
PULL_HELPER="$SCRIPT_DIR/wiki-pull-with-auto-resolve.sh"
LOG_FILE="$(platform_log_dir)/wiki-fetch.log"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG_FILE"
}

attempt_pull_on_delta() {
  # Retry on every poll while we remain behind. This avoids the failed-pull
  # wedge where last-behind is advanced before the pull runs and DELTA stays 0
  # forever until a fresh upstream commit arrives.
  if [ "$PULL_ON_DELTA" != "1" ] || [ "$BEHIND" -le 0 ]; then
    return 0
  fi

  if [ -f "$WIKI_DIR/.skillwiki/sync.lock" ]; then
    log "SKIP PULL sync lock present — leave pull to skillwiki sync"
    return 0
  fi
  if [ -f "$WIKI_DIR/.git/index.lock" ] || [ -d "$WIKI_DIR/.git/rebase-merge" ] || [ -d "$WIKI_DIR/.git/rebase-apply" ] || [ -f "$WIKI_DIR/.git/MERGE_HEAD" ]; then
    log "SKIP PULL git operation already in progress"
    return 0
  fi

  PULL_LOCK_FILE="$STATE_DIR/pull.lock"
  PULL_LOCK_RC=0
  lockfile_acquire "$PULL_LOCK_FILE" 600 || PULL_LOCK_RC=$?
  if [ "$PULL_LOCK_RC" -eq 1 ]; then
    log "SKIP PULL previous pull-on-delta still in flight"
    return 0
  elif [ "$PULL_LOCK_RC" -eq 2 ]; then
    log "PULL stale lock reclaimed"
  fi

  if [ -x "$PULL_HELPER" ]; then
    if "$PULL_HELPER" origin "$BRANCH" 2>>"$LOG_FILE"; then
      log "PULL ok via wiki-pull-with-auto-resolve"
    else
      log "FAIL PULL via wiki-pull-with-auto-resolve — run skillwiki sync manually"
    fi
  elif [ -f "$PULL_HELPER" ]; then
    if bash "$PULL_HELPER" origin "$BRANCH" 2>>"$LOG_FILE"; then
      log "PULL ok via bash wiki-pull-with-auto-resolve"
    else
      log "FAIL PULL via bash wiki-pull-with-auto-resolve — run skillwiki sync manually"
    fi
  elif git pull --rebase origin "$BRANCH" 2>>"$LOG_FILE"; then
    log "PULL ok via git pull --rebase"
  else
    log "FAIL PULL via git pull --rebase — run skillwiki sync manually"
  fi
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

# Opt-in auto-pull: consume sg01 Snapshot commits into the working tree.
# Uses wiki-pull-with-auto-resolve.sh for conflict-storm handling. On failure,
# leaves the working tree behind and logs — does NOT block. When the helper is
# present but not executable, invoke it via bash so we still get its dirty-tree
# and conflict-storm handling instead of falling back to a bare git pull.
attempt_pull_on_delta

exit 0
