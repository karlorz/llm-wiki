---
name: vault-sync-status
description: Health snapshot of vault-sync — scheduler health, push/fetch recency, filter integrity, snapshot guard, runtime manifest proof, and Linux fuse-refresh timer status. JSON + human output.
argument-hint: "[--read-only] [--json]"
---

# vault-sync-status

One-shot detailed health report of vault-sync on the current host. Reports scheduler state, role-specific log/filter/script checks, snapshot guard presence, runtime-manifest / live-verify proof, and Linux fuse-refresh timer status.

## When to use

- Quick health check after install
- Debugging sync issues
- CI read-only verification of production hosts (sg01)
- Before and after migration
- Proving installed runtime hashes match package sources after rollout

## Steps

1. **Resolve vault path once** (cwd-independent): `VS_VAULT_PATH` → `WIKI_PATH` → `skillwiki --human path` (absolute only) → `$HOME/wiki`. All git checks use `git -C "$VAULT_PATH"`.
2. **Run vault_sync_* doctor checks** directly (equivalent to `skillwiki doctor --only vault_sync` but available without skillwiki).
   - Reports `vault_sync_conflict_markers` so poisoned Markdown is visible before
     push, pull, or snapshot workflows continue.
3. **Read scheduler state**:
   - leaf/full hosts: wiki-push and wiki-fetch.
   - snapshotter hosts: wiki-snapshot.
4. **Check terminal helper state** for the installed `wiki-sync.sh` and the
   convenience `~/bin/wiki-sync.sh` symlink. Warn only; do not repair in status
   mode.
5. **Role-specific checks**:
   - leaf/full hosts: tail last 20 lines of `wiki-push.log` and `wiki-fetch.log`; check `wiki-push-filters.txt`.
   - snapshotter hosts: skip leaf push/fetch/filter checks as not applicable; verify the configured `vault_sync.snapshot_script` or packaged `wiki-snapshot.sh` contains `--max-delete`.
6. **Runtime proof checks** (read-only; never write markers):
   - `vault_sync_runtime_manifest` — `$(platform_share_dir)/runtime-manifest.json` present and parseable.
   - `vault_sync_runtime_match` — SHA-256 of installed package-source scripts match the manifest and package sources under the vault-sync package root.
   - `vault_sync_runtime_registration` — warn when scheduler jobs are enabled but runtime match is not pass.
   - `vault_sync_live_verify` — pass only when `$(platform_share_dir)/live-verify.ok` exists; otherwise warn. Status **never** creates this marker.
7. **Resolve S3 reachability without guessing a host-local alias**:
   - non-empty process `WIKI_REMOTE`;
   - otherwise `WIKI_REMOTE` from `~/.skillwiki/.env`;
   - otherwise, for snapshotters, `WIKI_REMOTE` or `CLOUD_REMOTE` parsed as data
     from the snapshot profile path resolved as:
     `VS_SNAPSHOT_PROFILE` → `vault_sync.snapshot_profile` in `~/.skillwiki/.env`
     → `/etc/vault-sync/profiles/$(hostname)-snapshotter.env`;
   - otherwise report `S3 remote not configured — reachability probe skipped`.
   A missing remote is unknown/unconfigured, not unreachable. Only a failed
   probe of a resolved remote produces an S3 warning. Snapshot profiles are
   parsed by exact assignment and are never sourced as shell code.
8. **Output**:
   - Default: human-readable two-column table.
   - `--json`: machine-readable record matching the doctor JSON shape.
9. **`--read-only` flag**: explicitly forbid any state-changing call. Used by sg01 e2e leg. The skill MUST honor this — no `touch`, no `launchctl print` (which on some platforms can spawn helpers), no service restart.

## S3 configuration contract

Rclone remote names such as `cloud:` or `seaweed-wiki:` are host-local aliases.
Managed leaf hosts should set `WIKI_REMOTE` explicitly in
`~/.skillwiki/.env`. Snapshotter services carry their operational source in the
systemd profile as `CLOUD_REMOTE`; status can consume that profile when
`WIKI_REMOTE` is absent. Do not interpret a shared legacy script default as
proof that the alias exists on the current host.

## Runtime proof and live verification

After install, operators should see:

| Check | Pass means |
|-------|------------|
| `vault_sync_runtime_manifest` | Install wrote a parseable inventory at `$(platform_share_dir)/runtime-manifest.json` |
| `vault_sync_runtime_match` | Installed script hashes match package sources (not just "files exist") |
| `vault_sync_live_verify` | Attended rollout touched `$(platform_share_dir)/live-verify.ok` after a live pull cycle showed `op=` journal lines |

Exact live-verify path:

- macOS: `~/Library/Application Support/vault-sync/live-verify.ok`
- Linux: `~/.local/share/vault-sync/live-verify.ok`

**Completion gate:** repository tests green ≠ work complete. Do not set the vault work item `status: completed` until live evidence (runtime match + pull log `op=` lines + `live-verify.ok`) is recorded in the work retro. See vault-sync-install attended verification checklist.

## Read-only contract

When `--read-only` is passed:
- No files are written (including never writing `live-verify.ok`).
- No services are restarted.
- No `launchctl` or `systemctl` commands that modify state.
- Only read operations: file existence checks, log tailing, config reads, hash comparison.

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
