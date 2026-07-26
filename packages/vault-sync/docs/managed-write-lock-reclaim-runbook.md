# Managed-write lock reclaim runbook

Attended recovery for a protected snapshotter when a stale managed-write lock
on the live FUSE vault blocks root projection materialization with
`SYNC_LOCK_HELD`.

This is a narrow recovery procedure, not general permission to edit the
snapshot Git worktree. On the production snapshotter, the affected lock is on
the live mutation root (`/root/wiki`), while Git convergence remains under the
configured snapshot worktree (normally `/root/wiki-git`).

## When to use

Use this runbook only when all of the following are true:

- `wiki-snapshot.service` failed at root projection materialization.
- The lock exists at `/root/wiki/.skillwiki/managed-write.lock`.
- The lock is valid JSON with a positive numeric `pid`.
- The lock owner is proven local, or an attended operator has explicitly
  confirmed that all possible foreign writers are idle for a legacy record
  without owner-host metadata.
- `kill -0` proves that PID is no longer alive.
- No operator or automation is currently running a managed SkillWiki write.

If the PID is alive, the lock is unreadable, the PID is missing/invalid, or
ownership changes during the procedure, stop. Do not reclaim by age alone.

## Diagnose

Run on the protected snapshotter as the service account (root on sg01):

```bash
snapshot_lock_path=/root/wiki/.skillwiki/managed-write.lock
snapshot_log_path=/root/.local/state/vault-sync/log/wiki-snapshot.log

test -f "$snapshot_lock_path"
jq '{pid, owner_hostname, command, acquired}' "$snapshot_lock_path"
grep -E 'SNAPSHOT_COMPLETE|SYNC_LOCK_HELD|FAIL root projection' \
  "$snapshot_log_path" | tail -20
systemctl show wiki-snapshot.service -p Result -p ExecMainStatus -p ActiveState
```

Extract and validate the owner PID. Missing or malformed values are a
fail-closed condition:

```bash
snapshot_lock_pid="$(jq -er '.pid | select(type == "number" and . > 0)' \
  "$snapshot_lock_path")" || exit 1
snapshot_lock_owner_host="$(jq -r '.owner_hostname // empty' \
  "$snapshot_lock_path")" || exit 1
snapshot_current_host="$(hostname)" || exit 1

if [ -n "$snapshot_lock_owner_host" ] \
  && [ "$snapshot_lock_owner_host" != "$snapshot_current_host" ]; then
  echo "STOP: lock belongs to foreign host $snapshot_lock_owner_host" >&2
  exit 1
fi

if kill -0 "$snapshot_lock_pid" 2>/dev/null; then
  echo "STOP: managed-write owner PID $snapshot_lock_pid is alive" >&2
  exit 1
fi
```

`kill -0` sends no signal. It only checks whether the recorded process still
exists on the current host. An alive PID always wins over lock age or snapshot
urgency. If `owner_hostname` is absent, the record predates host-aware locks:
coordinate with all leaf writers, confirm they are idle, and record that proof
before continuing. A local `kill -0` result cannot prove a foreign writer dead.

## Preserve and reclaim a dead owner

Back up the exact lock bytes before removing the live path. Recheck both the
PID and file fingerprint immediately before removal to avoid reclaiming a lock
that changed while the operator was diagnosing it.

```bash
snapshot_recovery_dir=/root/.cache/vault-sync/recovered-locks
snapshot_recovery_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot_lock_backup="$snapshot_recovery_dir/managed-write.lock.$snapshot_recovery_stamp"
snapshot_lock_sha="$(sha256sum "$snapshot_lock_path" | awk '{print $1}')" || exit 1

install -d -m 700 "$snapshot_recovery_dir"
cp -p -- "$snapshot_lock_path" "$snapshot_lock_backup"
cmp -s -- "$snapshot_lock_path" "$snapshot_lock_backup" || exit 1

if kill -0 "$snapshot_lock_pid" 2>/dev/null; then
  echo "STOP: owner PID became/live remains observable" >&2
  exit 1
fi

snapshot_current_sha="$(sha256sum "$snapshot_lock_path" | awk '{print $1}')" || exit 1
test "$snapshot_current_sha" = "$snapshot_lock_sha" || {
  echo "STOP: managed-write lock changed during recovery" >&2
  exit 1
}

rm -- "$snapshot_lock_path"
test ! -e "$snapshot_lock_path"
```

The backup is recovery evidence. Keep it until the incident is closed and the
automated recovery record, if any, has been reviewed.

## Restart and close out

Start the oneshot service through systemd rather than invoking the snapshot
script directly. This preserves the installed profile, service environment,
production flock, and normal logging path.

```bash
systemctl start wiki-snapshot.service
systemctl show wiki-snapshot.service -p Result -p ExecMainStatus -p ActiveState
journalctl -u wiki-snapshot.service -n 80 --no-pager
grep -E 'SNAPSHOT_COMPLETE|SYNC_LOCK_HELD|FAIL root projection' \
  /root/.local/state/vault-sync/log/wiki-snapshot.log | tail -30
skillwiki doctor
```

Close the incident only when:

- `Result=success` and `ExecMainStatus=0` for `wiki-snapshot.service`.
- The snapshot log contains a new terminal `SNAPSHOT_COMPLETE result=success`.
- `skillwiki doctor` reports `0 error` (an optional cold-FUSE performance
  warning does not invalidate the recovery).
- The preserved backup path and the new snapshot completion evidence are
  recorded in the work log.

## Prohibited shortcuts

- Never reclaim a lock whose PID is alive.
- Never reclaim solely because `acquired` is old.
- Never force-push the vault repository.
- Never edit, delete, or hand-stage files under `/root/wiki-git` to repair this
  incident.
- Never bypass `wiki-snapshot.service` by running an ad hoc promotion after
  deleting the lock.
- Never install vault-sync on sg02 as part of this recovery.

Protected does not mean a dead FUSE lock can never be reclaimed. It means the
reclaim must be dead-PID-only, evidence-preserving, attended, and followed by
the normal protected snapshot service and health checks.
