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
next 300 s cycle retries. `WIKI_PUSH_FAIL_DEDUP_DISABLE=1` restores legacy
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

## Snapshot promotion after a failed GitHub push

The 2026-11-04/05 outage left local snapshot `d6c5244d7` unpushed after
`1f0b55ae2`. A one-sided ancestor check classified that healthy ahead history
as divergence, then attempted to invoke an absent `wiki-git-repair-v3.sh`.
The emergency copy into the live runtime payload restored the helper only for
that immutable release; it is not durable across runtime upgrades. The helper
is now a package-owned sibling of `wiki-snapshot.sh`, copied by both the full
installer and `scripts/lib/deploy-runtime.py`, with payload/manifest tests.

Snapshot promotion distinguishes equal, behind, ahead, and truly divergent
histories against a successfully fetched `origin/main`. An ahead checkout keeps
its commits and resumes commit/push, including when S3 supplied no new changes.
A failed push leaves the candidate intact for the next run. Failure to fetch
is logged as transport failure, rather than classified as divergence.

The packaged repair helper refuses unmerged paths, `MERGE_HEAD`, `index.lock`,
detached HEAD, missing rebase todo, and non-empty rebase todo. An empty rebase
todo permits only creation of a recovery ref followed by `git rebase --quit`.
Equal and ahead histories succeed without moving HEAD; behind histories use
`git merge --ff-only`, which can itself refuse conflicting dirty files. True
divergence requires attended review. Recovery never resets, cleans, stashes,
or aborts a rebase. A missing/unreadable helper produces the stable diagnostic
`ERROR: Git repair helper missing or unreadable:` before any Bash invocation.

### Byte parity followed by semantic-preview refusal

A separate refusal was observed on sg01 on 2026-11-05 at 16:42–16:43 CST:
`index.md` (`63f3b7b5…`) and `log.md` (`cd436bdb…`) matched the current store
hashes, but semantic preview still reported drift after one retry. This evidence
establishes equality of those two projection objects, not consistency of the
source page tree or log-event inventory. It does not establish a false positive
or identify a particular racing page.

Preview regenerates the index from typed-page frontmatter and project READMEs
in the synced worktree. It regenerates the log from the direct-S3 event inventory
captured before materialization (`--events-from`), not from the projection
object itself. A page arriving before its index update, an event/projection
mismatch, or deterministic differences in the source universe can therefore
produce semantic drift even when both projection objects match S3. The existing
single retry may resolve transient lag; repeated drift remains a refusal.
Hash parity alone must not bypass the semantic gate.

On each failed preview attempt, the snapshot journal and durable log now retain:

- `projection semantic preview inputs`: worktree, event-inventory source, and
  expected index/log hashes for that attempt.
- `projection semantic preview JSON`: the complete CLI response, including
  separate `index_drift` and `log_drift` flags or command error details.

Read both attempts and the surrounding worktree-parity records. `index_drift`
points to source pages/project manifests versus the stored index; `log_drift`
points to event inputs versus the stored log. The current CLI response does
not name individual differing pages, so page-level attribution still requires
read-only inspection of that source universe; do not infer a page from the
projection hash. Temporary preview/event directories are removed on exit, so
use the retained log evidence rather than their printed paths after completion.

The diagnostic change does not rewrite worktree projections, extend the retry
budget, loosen delete-intent reconciliation, or change `--max-delete 10`.
Do not author in the snapshot checkout or use `git reset --hard` as recovery.
