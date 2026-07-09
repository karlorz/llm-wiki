# Offline host runbook

This runbook classifies **independent** availability states:

| State | Meaning |
|---|---|
| `local_vault` | The checkout at `~/wiki` is readable/writable and has valid Git metadata. |
| `github_remote` | `origin/main` can be fetched/pushed depending on operation. |
| `s3_remote` | configured rclone S3 remote can be listed or written depending on operation. |
| `snapshotter_host` | sg01 or replacement snapshotter can be reached for rollout/status checks. |

Rule: local skillwiki reads/writes require only `local_vault`. Sync and promotion
commands may degrade when remote stores or hosts are unavailable, but they must
report which dependency failed.

Use `skillwiki sync status` (local-first) and `skillwiki sync status --include-remote-health` (opt-in probes). Use `skillwiki doctor` for detailed reachability checks.

## Outage matrix

| Outage | Safe actions | Blocked actions | Recovery |
|---|---|---|---|
| sg01 offline | local skillwiki, macOS GitHub commits, S3 push | snapshot promotion, sg01 install verification | restore sg01 or promote a replacement snapshotter from GitHub + S3 |
| GitHub offline | local work, S3 push | git pull/push, release verification | push when GitHub returns |
| S3 offline | local work, GitHub push | wiki-push, snapshot from S3 | push/copy when S3 returns |
| macOS offline | sg01 snapshots, other hosts | macOS local edits | pull from GitHub/S3 on return |
| leaf host offline | all other hosts continue | that leaf's local work | pull from GitHub/S3 on return |

**Warning:** do not treat `sg01` as data authority. It is a worker that can be rebuilt from the GitHub repo, S3 remote, vault-sync package, and `fleet.yaml`.

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