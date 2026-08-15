# SkillWiki Maintenance Profiles

`@skillwiki/maintenance` runs the Stage 1 satellite workflow through explicit
internal profiles while preserving the existing CLI surface:

- `full` -> `attended-full`
- `daily` -> `unattended-daily`
- `self-update` -> `self-update-check`
- `self-update-apply` -> `self-update-apply`
- `session-brief-refresh` -> `session-brief-refresh`

## Current Profile Rules

| CLI mode | Internal profile | Self-update check | Vault preflight | Selected jobs | Writes allowed | Blocking health findings |
| --- | --- | --- | --- | --- | --- | --- |
| `full` | `attended-full` | yes | yes | `agent-memory-trends-daily`, `session-brief-refresh`, `health-summary` | yes | fatal (`fail`) |
| `daily` | `unattended-daily` | no | yes | `agent-memory-trends-daily`, `health-summary` | yes, one vault writer max | advisory (`warn`) |
| `self-update` | `self-update-check` | yes | no | none | no | n/a (no health job) |
| `self-update-apply` | `self-update-apply` | no | yes | none | yes, but no vault-writer jobs | n/a (no health job) |
| `session-brief-refresh` | `session-brief-refresh` | no | yes | `session-brief-refresh` | yes, one vault writer | n/a (no health job) |

Safety invariants:

- Fleet `maintenance.skillwiki_satellite.jobs` must stay in the approved Stage 1 order.
- `health-summary` is always read-only.
- Only the declared writer jobs may mutate the vault, and later writers are skipped once one commit succeeds or fails.
- Dedicated single-writer profiles such as `session-brief-refresh` may push their committed writer output immediately.
- Protected hosts must reject mutating profiles.
- `healthFindingsAreAdvisory` is a profile-level exit policy, not a health
  tooling change: on `unattended-daily`, a successfully executed and parsed
  health report with blocking findings maps to `warn` so pre-existing vault
  content debt does not overturn a successful writer/push transaction. Health
  command execution failures, missing/unreadable reports, and JSON parse
  failures remain `fail` in every profile. `attended-full` keeps the strict
  mapping (`fail`).

## Maintenance Lock

Every `runStage1Maintenance` invocation takes an exclusive maintenance lock
before starting and releases it when the run finishes, so overlapping timers
(nightly, self-update, manual runs) serialize instead of failing immediately.

- On contention the runner polls the lock every 2 seconds and waits up to
  `SKILLWIKI_MAINTENANCE_LOCK_WAIT_MS` (default 900000 = 15 minutes, safely
  under the systemd `RuntimeMaxSec` cap) before failing with `LOCK_HELD`. The
  CLI flag `--lock-wait-ms <ms>` overrides the environment variable; both
  accept a non-negative integer.
- A stale lock is reclaimed only when its `owner.json` is both expired
  (`expires_at` older than the 30-minute TTL) and its recorded `pid` is no
  longer alive. The stale owner record is preserved under
  `<lock parent>/recovery/<timestamp>-<token>.json` before the stale lock
  directory is removed. A live owner or an unreadable record is never
  reclaimed — the runner keeps waiting until the wait deadline.
- Release is ownership-guarded: the lock directory is removed only while the
  recorded ownership token still matches the releasing handle, so a reclaim
  or a crashed predecessor can never delete a freshly acquired lock.

## Add A Satellite Job Safely

1. Decide whether the new job is read-only or writing. Default to read-only unless it must mutate the repo or vault.
2. Add the job ID to `packages/shared/src/schemas.ts` and `packages/skillwiki-maintenance/src/types.ts`.
3. Implement the job under `packages/skillwiki-maintenance/src/jobs/`.
4. Add RED tests first for the job itself and for the profile(s) that should run it.
5. Update `packages/skillwiki-maintenance/src/profiles.ts`:
   - add the job only to the profiles that should run it
   - classify it as read-only or writer
   - keep the selected job order aligned with the approved Stage 1 order
6. Update `packages/skillwiki-maintenance/src/config.ts` and the fleet manifest only if the approved Stage 1 order or schema genuinely changes.
7. If the job writes, confirm it still respects the single-writer-per-run guard.
8. Re-run:
   - `npm run -w @skillwiki/maintenance test`
   - `npm run -w @skillwiki/maintenance build`

## Add A New Profile Safely

1. Keep the public CLI/fleet surface unchanged unless there is explicit approval for a schema or CLI migration.
2. Add the internal profile definition in `packages/skillwiki-maintenance/src/profiles.ts`.
3. Make the profile explicit about:
   - selected jobs
   - read-only jobs
   - writer jobs
   - whether self-update check, preflight, or self-update apply runs
   - whether a committed writer should push immediately
   - whether parsed blocking health findings are advisory for the exit outcome
     (`healthFindingsAreAdvisory`; enable only for unattended profiles that
     must not be overturned by pre-existing content debt)
4. Add tests for:
   - resolved profile metadata
   - protected-host behavior
   - fail-closed ordering and validation
5. Avoid adding ad hoc `mode === ...` branches to the orchestrator when a profile definition can carry the behavior.
