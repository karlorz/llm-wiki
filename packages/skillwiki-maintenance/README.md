# SkillWiki Maintenance Profiles

`@skillwiki/maintenance` runs the Stage 1 satellite workflow through explicit
internal profiles while preserving the existing CLI surface:

- `full` -> `attended-full`
- `daily` -> `unattended-daily`
- `self-update` -> `self-update-check`
- `self-update-apply` -> `self-update-apply`
- `session-brief-refresh` -> `session-brief-refresh`

## Current Profile Rules

| CLI mode | Internal profile | Self-update check | Vault preflight | Selected jobs | Writes allowed |
| --- | --- | --- | --- | --- | --- |
| `full` | `attended-full` | yes | yes | `agent-memory-trends-daily`, `session-brief-refresh`, `health-summary` | yes |
| `daily` | `unattended-daily` | no | yes | `agent-memory-trends-daily`, `health-summary` | yes, one vault writer max |
| `self-update` | `self-update-check` | yes | no | none | no |
| `self-update-apply` | `self-update-apply` | no | yes | none | yes, but no vault-writer jobs |
| `session-brief-refresh` | `session-brief-refresh` | no | yes | `session-brief-refresh` | yes, one vault writer |

Safety invariants:

- Fleet `maintenance.skillwiki_satellite.jobs` must stay in the approved Stage 1 order.
- `health-summary` is always read-only.
- Only the declared writer jobs may mutate the vault, and later writers are skipped once one commit succeeds or fails.
- Dedicated single-writer profiles such as `session-brief-refresh` may push their committed writer output immediately.
- Protected hosts must reject mutating profiles.

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
4. Add tests for:
   - resolved profile metadata
   - protected-host behavior
   - fail-closed ordering and validation
5. Avoid adding ad hoc `mode === ...` branches to the orchestrator when a profile definition can carry the behavior.
