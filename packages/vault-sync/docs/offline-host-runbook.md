# Offline host runbook

This runbook classifies **independent** availability states:

| State | Meaning |
|---|---|
| `local_vault` | The checkout at `~/wiki` is readable/writable and has valid Git metadata. |
| `github_remote` | `origin/main` can be fetched/pushed depending on operation. |
| `s3_remote` | An explicitly configured or snapshot-profile rclone S3 remote can be listed or written depending on operation. |
| `snapshotter_host` | sg01 or replacement snapshotter can be reached for rollout/status checks. |

Rule: local skillwiki reads/writes require only `local_vault`. Sync and promotion
commands may degrade when remote stores or hosts are unavailable, but they must
report which dependency failed.

Use `skillwiki sync status` (local-first) and `skillwiki sync status --include-remote-health` (opt-in probes). Use `skillwiki doctor` for detailed reachability checks.

Rclone remote names are host-local aliases. A missing `WIKI_REMOTE` is an
unconfigured/unknown diagnostic state, not evidence of an S3 outage. On a
snapshotter, `vault-sync-status` may resolve the remote from the systemd
snapshot profile's `CLOUD_REMOTE`. Classify S3 as offline only after a probe of
an explicitly resolved remote fails.

## Outage matrix

| Outage | Safe actions | Blocked actions | Recovery |
|---|---|---|---|
| sg01 offline | local skillwiki, macOS GitHub commits, S3 push | snapshot promotion, sg01 install verification | restore sg01 or promote a replacement snapshotter from GitHub + S3 |
| GitHub offline | local work, S3 push | git pull/push, release verification | push when GitHub returns |
| S3 offline | local work, GitHub push | wiki-push, snapshot from S3 | push/copy when S3 returns |
| macOS offline | sg01 snapshots, other hosts | macOS local edits | pull from GitHub/S3 on return |
| leaf host offline | all other hosts continue | that leaf's local work | pull from GitHub/S3 on return |

**Warning:** do not treat `sg01` as data authority. It is a worker that can be rebuilt from the GitHub repo, S3 remote, vault-sync package, and `fleet.yaml`.

## Push refusal states (S3 push is gated beyond reachability)

`wiki-push.sh` can refuse the S3 push for reasons unrelated to S3
reachability: missing wiki dir/filters, case-only path collisions,
path_too_long fix failure, conflict markers, and lint-delta new errors.
Since the 2026-08-13 exit-honesty refactor, refusals:

- exit non-zero (the launchd plist uses `StartInterval`, so exit codes are
  signal, not backoff triggers), and
- write a durable terminal-state record at
  `<platform_cache_dir>/wiki-push-result.state` (`result=ok` /
  `result=refused reason=<class> timestamp=<ISO>`), which
  `vault-sync-status` surfaces as `vault_sync_last_push_result` and which
  survives log rotation.

The S3 push and git convergence state are coupled: a pull-side
review-required handoff blocks pulls, the dirty backlog grows, and the M1
dirty-volume gate (threshold 50) refuses non-hygiene writes. `lint --fix`
is hygiene-classified (not gated) and `raw/` long paths are inherited debt
(WARN, non-blocking), so a `result=refused reason=path-fix-failed` record
means a non-raw path could not be renamed — inspect the push log for the
unresolved path.

Recovery is attended: fix the refusal cause, remove `wiki-push.paused` if
the P1 pause triggered (and `launchctl load` the plist if unloaded); the
next 60 s cycle retries. `WIKI_PUSH_FAIL_DEDUP_DISABLE=1` restores legacy
per-cycle FAIL logging as a first-line rollback.

## Related: stale managed-write lock on FUSE snapshotter

If `wiki-snapshot.service` fails root projection with `SYNC_LOCK_HELD` because
`/root/wiki/.skillwiki/managed-write.lock` is held by a **dead** PID, use the
attended procedure in
[`managed-write-lock-reclaim-runbook.md`](./managed-write-lock-reclaim-runbook.md)
(dead-PID only, fingerprinted backup, `systemctl start wiki-snapshot.service`,
doctor closeout). Do not force-push and do not hand-edit `/root/wiki-git`.

Leaf prevention: `filters/wiki-push-filters.txt` excludes
`.skillwiki/managed-write.lock` so transient locks are not republished to S3.

## Staged / rsync install provenance

When installing from a **rsynced or staged** package tree that is not a full
monorepo checkout, `runtime-manifest.json` can record `package_version: 0.0.0`
and an empty `package_commit` because helpers walk `../../package.json` and git.

Set deploy provenance (metadata only; does not change copied scripts):

```bash
VS_PACKAGE_VERSION=0.9.60 \
VS_PACKAGE_COMMIT=<source-monorepo-git-sha> \
bash skills/vault-sync-install/install.sh --role snapshotter --service-scope system --execute
```

Equivalent flags: `--package-version` / `--package-commit` (assign the same env).

Prefer a monorepo-shaped tree (`package.json` with `"version"` two levels above
`packages/vault-sync`) when possible; overrides remain the headless SSOT for
CI and attended rsync deploys.

## Satellite-only leaf hosts (e.g. sg02)

Some fleet leaves intentionally **do not** install vault-sync timers when
`writes_to` is GitHub-only and skillwiki satellite maintenance
(`vault-sync-preflight`, self-update) keeps the vault checkout current.

On those hosts:

- Missing `~/.local/share/vault-sync` is **expected**, not an automatic outage.
- Prefer satellite journals + `git` as the maintenance user (e.g. `agent-memory`).
- Do not run GitHub probes as root if host keys / SSH identity differ.
- Install leaf vault-sync only after an explicit product decision (not by default).

## Status hang avoidance

`vault-sync-status` bounds network reachability probes (`timeout` → `gtimeout`
→ python3 → bash kill). Default bound is 3 seconds
(`VS_REACHABILITY_TIMEOUT`).

On time-bound snapshotter checks, prefer timers + log tails +
`runtime-manifest.json` over a full doctor run. Always invoke status from the
**same package root used to install** (monorepo or plugin cache), not ad-hoc
worktrees.

## Snapshotter failover (manual)

Do not implement automatic failover in this phase. Manual failover is safer until the fleet has fencing/lease semantics.

1. Confirm sg01 outage is real with both declared aliases and provider console if available.
2. Pick a replacement host from `fleet.yaml` or provision a new Linux host.
3. Clone the GitHub wiki repo into the snapshot worktree.
4. Configure rclone S3 remote read access.
5. Install vault-sync snapshotter role.
6. Run `wiki-snapshot.sh --dry-run`.
7. Run read-only `vault-sync-status`.
8. Promote `fleet.yaml` so exactly one host has role `snapshotter`.
9. Enable the snapshot timer only after the old sg01 snapshotter is confirmed stopped or unreachable with no risk of split-brain.
