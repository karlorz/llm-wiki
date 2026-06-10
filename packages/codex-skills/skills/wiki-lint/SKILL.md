---
name: wiki-lint
description: Vault health check via the umbrella `skillwiki lint` subcommand. Read-only by default; rotation requires explicit user consent.
---
# wiki-lint
## When This Skill Activates
- User asks for a vault health report, lint, or audit.
- Periodic maintenance.
## Pre-orientation reads
Standard four reads.
## Steps
0. Resolve vault: `skillwiki path` (record source for context).
- **CRITICAL**: Verify the correct vault when the user has multiple wiki instances (e.g., ~/wiki vs ~/wiki-fin). User may explicitly specify which vault to target — confirm before destructive operations.
1. For a whole-system health report, run `skillwiki health <vault> --out /tmp/skillwiki-health.json --no-fail`. Read the JSON envelope from stdout or the report file. Treat `skillwiki doctor` as setup/runtime diagnostics only, not a vault-content health report.
2. For lint-only maintenance, run `skillwiki lint <vault> --summary`. This returns bounded bucket counts, capped examples, and `details_command` hints without full item arrays.
3. Drill into important buckets with `skillwiki lint <vault> --only <bucket>` when examples are insufficient for remediation.
4. Reason over findings; present grouped by severity with concrete suggested actions per kind. If the CLI was recently updated with new lint checks, re-running lint on the full vault may flag pre-existing pages that predate the new rule — treat these as legitimate findings, not false positives.
5. If `log_rotate_needed` is present and the user consents, run `skillwiki log-rotate <vault> --apply`. Otherwise leave alone.
6. **Post-migration verification**: If the user recently migrated content (e.g., moved entity/concept pages to another vault), re-run `skillwiki lint <vault> --summary` and verify that broken_wikilinks count decreased. Remaining broken links for migrated content indicate pages still referencing the moved files — these should be cleaned up (remove citations or migrate the referencing pages too).
7. Append a `log.md` entry summarizing lint counts only when the user asked to record the maintenance result. Do not log routine `health` reports by default.
## Stop conditions
None — lint reports all findings even on per-page errors.
## Forbidden
- Auto-rotating logs.
- Auto-updating sha256 fields.
- Modifying any page beyond a user-approved lint summary entry in `log.md`.
