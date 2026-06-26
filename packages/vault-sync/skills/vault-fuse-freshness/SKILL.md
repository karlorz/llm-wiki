---
name: vault-fuse-freshness
description: Audit and refresh rclone FUSE visibility freshness for cross-device wiki sync. Linux-focused; enforces <=15m dir-cache-time envelope, can forget stale VFS directory cache entries, and triggers bounded rclone rc vfs/refresh.
argument-hint: "[--check-only] [--max-dir-cache=<duration>] [--forget-dir=<path>] [--dry-run]"
---

# vault-fuse-freshness

Audit and maintain S3->FUSE visibility freshness on Linux hosts that consume the wiki through an rclone mount.

## When to use

- New host bring-up after `/vault-sync-install`
- Investigating stale directory listings on pvelxc/LXC hosts
- Verifying `--dir-cache-time` remains within the cross-device SLA envelope

## What it does

1. Detects a running `rclone mount` process.
2. Audits effective `--dir-cache-time` against a threshold (default `15m`).
3. Optionally runs `rclone rc vfs/forget dir=<path>` for targeted stale directory listings.
4. Runs bounded `rclone rc vfs/refresh recursive=true dir=/` when RC is enabled.
5. Logs outcomes to `$(platform_log_dir)/wiki-fuse-refresh.log`.

## Guardrails

- Linux-focused workflow. On non-Linux hosts, it exits with a skip message.
- Does not modify mount unit files; it validates runtime behavior and refreshes the VFS view.
- If `--dir-cache-time` exceeds threshold, returns non-zero so automation can flag drift.
- `vfs/forget` uses `dir=<path>` or `file=<path>` keys. Do not pass `recursive=true` to `vfs/forget`; recursive refresh is only for `vfs/refresh`.
- RC calls are wrapped with `timeout`; override with `VS_FUSE_RC_TIMEOUT_SECONDS=<seconds>` when needed.

## Execution

```bash
# Companion script (interactive)
bash packages/vault-sync/skills/vault-fuse-freshness/fuse-freshness.sh --check-only
bash packages/vault-sync/skills/vault-fuse-freshness/fuse-freshness.sh --max-dir-cache 10m
bash packages/vault-sync/skills/vault-fuse-freshness/fuse-freshness.sh --forget-dir _archive
bash packages/vault-sync/skills/vault-fuse-freshness/fuse-freshness.sh --dry-run

# Companion script (headless / CI)
VS_FUSE_CHECK_ONLY=1 VS_FUSE_MAX_DIR_CACHE=15m bash packages/vault-sync/skills/vault-fuse-freshness/fuse-freshness.sh
VS_FUSE_FORGET_DIRS="_archive raw" VS_FUSE_RC_TIMEOUT_SECONDS=60 bash packages/vault-sync/skills/vault-fuse-freshness/fuse-freshness.sh
```
