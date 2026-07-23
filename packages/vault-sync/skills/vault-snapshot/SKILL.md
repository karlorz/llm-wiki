---
name: vault-snapshot
description: Linux-only S3-to-Git snapshot/promotion job with tombstone-aware no-resurrection and bounded remote pruning. Single-writer-git invariant — only one host per fleet may run this.
argument-hint: "[--dry-run]"
---

# vault-snapshot

Linux-only snapshot/promotion skill for the vault. Materializes root projections
through the live vault, syncs direct S3 content into the Git worktree, strips
active delete-intent paths before staging, commits, and pushes to GitHub with
rebase-based merge. Enforces the single-writer-git invariant: only the
designated snapshotter host per fleet may run this.

## When to use

- On the designated snapshotter host (e.g., sg01) during hand-migration from the legacy Hermes cron script
- Verifying snapshot guardrails before enabling the timer
- Testing snapshot logic on a non-production Linux host

## Guardrails

1. **`platform_require linux`** — hard block on non-Linux hosts. The snapshot script depends on Linux-specific tools and the rclone FUSE mount path convention.
2. **`--max-delete 10`** — NON-NEGOTIABLE clamp on `rclone sync` (and by extension `rsync --delete`) to prevent mass deletion during S3 inconsistency events. Reference: `raw/transcripts/2026-05-23-bug-sg01-snapshot-destructive-rclone-sync.md`.
3. **Single-writer-git** — only one host per fleet may act as snapshotter. Fleet role enforcement via `fleet.yaml`.
4. **Delete-intent no-resurrection** — active Git tombstones always strip matching paths from the snapshot worktree before `git add`, even when the optional S3 prune is unavailable.
5. **Bound attempts, not successes** — `WIKI_SNAPSHOT_MAX_TOMBSTONE_PRUNES` defaults to 10 and caps exact `deletefile` calls. The snapshot intersects active tombstones with a successful recursive remote inventory, so already-absent keys cause zero delete calls.
6. **Unknown is not absent** — a failed remote inventory skips optional tombstone pruning with an explicit warning; it never becomes an empty-set proof.

## Steps

1. **Platform check** — `platform_detect_os; platform_require linux`.
2. **Read fleet.yaml** via `fleet_load`. Confirm this host's role is `snapshotter`. If not, abort with message.
3. **Run guard verification** — call `wiki_snapshot_assert_guards` against the snapshot script body to verify `--max-delete` is present.
4. **Execute snapshot script** — call `wiki-snapshot.sh` (in `$(platform_share_dir)/bin/`). Pass `--dry-run` if the skill was invoked with `--dry-run`.
5. **Verify delete-intent summary** — expect one stable line with `active`, `inventory_ready`, `remote_present`, `attempted`, `pruned`, `already_absent`, `failed`, and `deferred` counters. In a zero-live-key steady state, `attempted=0` and no tombstone `object not found` block should appear.
6. **Log results** — write to `$(platform_log_dir)/wiki-snapshot.log`. Include start timestamp, exit code, and summary.

## Execution

```bash
# Interactive (Claude Code / Codex) — dry-run by default
/vault-snapshot --dry-run

# Interactive — execute
/vault-snapshot

# Terminal (after install)
bash $(platform_share_dir)/bin/wiki-snapshot.sh --dry-run
bash $(platform_share_dir)/bin/wiki-snapshot.sh
```

## Hand-migration checklist

When migrating from sg01's legacy `wiki-snapshot-v3.sh`:

- [ ] Copy the rsync+git+push body from `/root/.hermes/scripts/wiki-snapshot-v3.sh` into `$(platform_share_dir)/bin/wiki-snapshot.sh`.
- [ ] Verify `--max-delete 10` is present in the rclone/rsync delete call.
- [ ] Replace `flock` with `lockfile_acquire` from `lib/lockfile.sh`.
- [ ] Replace hardcoded paths with `platform_*` helpers.
- [ ] Source `lib/platform.sh` at the top of the script.
- [ ] Test on sg01: `sudo -u hermes bash wiki-snapshot.sh --dry-run`.
- [ ] Enable the systemd timer: `systemctl enable --now wiki-snapshot.timer` for system scope, or `systemctl --user enable --now wiki-snapshot.timer` for user scope. Default snapshotter cadence is every 30 minutes at `*:02` and `*:32`.
