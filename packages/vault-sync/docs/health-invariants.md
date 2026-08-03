# Snapshot health invariants

Permanent house rules for the vault-sync snapshot-health surfaces
(`skillwiki doctor`, `skillwiki health`, and the `vault-sync-status` shell
skill). These lock the lessons from the 0.10.14 -> 0.10.15 -> 0.10.16
corrective arc. Future contributors must not regress them silently.

## H1 - Property catalog is the single source of truth

Semantic health fields map through the shared systemd property catalog
(`packages/shared/src/systemd-property-catalog.json`), never hardcoded
ad-hoc snake_case `systemctl` names in call sites.

- TypeScript doctor reads the catalog via `packages/shared`.
- Shell `status.sh` sources the generated adapter
  (`systemd-property-catalog.sh`); the generator
  (`generate-systemd-property-catalog.mjs`) is the only thing that writes
  it. `npm run check:systemd-catalog` fails CI on drift.

Rationale: live `systemctl show` returns case-sensitive PascalCase names
(`ActiveEnterTimestamp`, `ExecMainStatus`). The 0.10.14 -> 0.10.15 fix
caught snake_case assumptions that fixture-key parity missed.

## H2 - Completed oneshot evidence order

A completed oneshot with an **empty `ActiveEnterTimestamp`** is still
classified as success when `ExecMainExitTimestamp` or
`InactiveEnterTimestamp` is present. `ActiveEnterTimestamp` alone is
insufficient (often empty for oneshots).

Regression test: `snapshot-health-parity.test.ts` scenario
"completed oneshot with empty ActiveEnterTimestamp is pass" and shell
live-adapter `system/completed` scenario (profile `completed` has empty
`ActiveEnterTimestamp`).

## H3 - Running elapsed uses ExecMainStartTimestamp

For a running service, elapsed time uses `ExecMainStartTimestamp`, not
`ActiveEnterTimestamp`. Covered by the `running` live-adapter scenario.

## H4 - Resolve live vault before fleet load

`runSnapshotMaintenanceDryRun` resolves the live vault **before** loading
`fleet.yaml`. Never pass `vault: ""` - empty string is not nullish and
suppresses `WIKI_PATH` / home-dotenv resolution, yielding
`UNKNOWN_IDENTITY` on every dry-run (the 0.10.16 bug).

Regression test: `snapshot-maintenance.test.ts` "resolves fleet identity
from live vault path without injected fleetLoad (v0.10.16)".

## H5 - Production Git proof uses the guard worktree

Production status / Git proof on a snapshotter reads
`/root/wiki-git` (the guard worktree), not the FUSE consumer mount at
`/root/wiki`. The FUSE mount can be stale or unavailable independent of
Git state. Operators must query the worktree path for authoritative
head/origin proof.

## H6 - Fixture key parity is not live adapter proof

Fixture-key parity (the 18-scenario corpus) is necessary but not
sufficient. CI must also run the live fake-systemctl adapter gate
(`snapshot-health-live-adapter.test.sh` + the TS live-adapter assertions
in `snapshot-health-parity.test.ts`) so that property-name mapping is
exercised against a binary that speaks systemd's property language.

`ci.yml` runs both. The live gate has a regression guard: it fails if
the adapter queries only snake_case names.

## H7 - Release blockers at canary produce a new immutable tag

A release blocker found at canary produces a **new** immutable tag
(e.g. 0.10.16 after 0.10.15). Never move or rewrite a prior tag. Tags
are release provenance; rewriting them breaks downstream update
detection and audit trails.

## H8 - macOS jobs require valid deployed plist definitions

For macOS leaf hosts, `vault_sync_jobs_enabled=pass` means more than two
LaunchAgent paths exist. Both deployed plist files must be structurally valid,
carry their expected `Label`, and provide `ProgramArguments[0]`; live status
also requires each label to be registered with launchd. A stale in-memory
launchd registration must never mask malformed on-disk configuration.

`runtime-manifest.json` records exact installed plist hashes. Status compares
those entries to the deployed plist files, while the installer restores a
previous plist after failure only when that previous artifact passed the same
integrity validation. Regression coverage must include malformed files, stale
loaded labels, manifest drift, valid rollback, and invalid-rollback refusal.

## Accepted differences between surfaces

`vault-sync-status` (shell) and `doctor` (TS) share check IDs for the
common snapshot-health checks. The shell surface additionally runs
ops-only checks that doctor does not:

| Shell-only check | Why it stays shell-only |
|---|---|
| `vault_sync_fuse_refresh_job` | Linux FUSE timer; doctor is cross-platform |
| `vault_sync_runtime_manifest` / `vault_sync_runtime_match` / `vault_sync_runtime_registration` | Install-time manifest proof; doctor is runtime health |
| `vault_sync_presync_helper` / `vault_sync_live_verify` | Pre-push hooks; not doctor's scope |
| `vault_sync_script_drift` / `vault_sync_conflict_markers` / `vault_sync_scan_conflict_markers` | Source-tree integrity; doctor is deployment health |

These are accepted differences, not regressions. The shared IDs
(`vault_sync_jobs_enabled`, `vault_sync_snapshot_service_result`,
`vault_sync_last_push_age`, `vault_sync_snapshot_consecutive_failures`,
`vault_sync_snapshot_guard`, `vault_sync_installed`,
`vault_sync_filter_present`, `vault_sync_last_fetch_status`) must stay
aligned in meaning and status vocabulary across both surfaces.
