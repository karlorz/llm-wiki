---
name: vault-sync-status
description: Health snapshot of vault-sync — scheduler health, push/fetch recency, filter integrity, snapshot guard, and Linux fuse-refresh timer status. JSON + human output.
argument-hint: "[--read-only] [--json]"
---

# vault-sync-status

One-shot detailed health report of vault-sync on the current host. Reports scheduler state, role-specific log/filter/script checks, snapshot guard presence, and Linux fuse-refresh timer status.

## When to use

- Quick health check after install
- Debugging sync issues
- CI read-only verification of production hosts (sg01)
- Before and after migration

## Steps

1. **Run vault_sync_* doctor checks** directly (equivalent to `skillwiki doctor --only vault_sync` but available without skillwiki).
2. **Read scheduler state**:
   - leaf/full hosts: wiki-push and wiki-fetch.
   - snapshotter hosts: wiki-snapshot.
3. **Check terminal helper state** for the installed `wiki-sync.sh` and the
   convenience `~/bin/wiki-sync.sh` symlink. Warn only; do not repair in status
   mode.
4. **Role-specific checks**:
   - leaf/full hosts: tail last 20 lines of `wiki-push.log` and `wiki-fetch.log`; check `wiki-push-filters.txt`.
   - snapshotter hosts: skip leaf push/fetch/filter checks as not applicable; verify the configured `vault_sync.snapshot_script` or packaged `wiki-snapshot.sh` contains `--max-delete`.
5. **Output**:
   - Default: human-readable two-column table.
   - `--json`: machine-readable record matching the doctor JSON shape.
6. **`--read-only` flag**: explicitly forbid any state-changing call. Used by sg01 e2e leg. The skill MUST honor this — no `touch`, no `launchctl print` (which on some platforms can spawn helpers), no service restart.

## Read-only contract

When `--read-only` is passed:
- No files are written.
- No services are restarted.
- No `launchctl` or `systemctl` commands that modify state.
- Only read operations: file existence checks, log tailing, config reads.

This is the **safety lifeline for sg01**. Test ruthlessly.

## Execution

```bash
# Companion script (interactive)
bash packages/vault-sync/skills/vault-sync-status/status.sh
bash packages/vault-sync/skills/vault-sync-status/status.sh --json
bash packages/vault-sync/skills/vault-sync-status/status.sh --read-only   # sg01 safe mode

# Companion script (headless / CI)
VS_READ_ONLY=1 VS_JSON=1 bash packages/vault-sync/skills/vault-sync-status/status.sh
```
