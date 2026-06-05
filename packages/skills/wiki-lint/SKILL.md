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
1. Run `skillwiki lint <vault>`. Read the JSON.
2. Reason over findings; present grouped by severity with concrete suggested actions per kind. If the CLI was recently updated with new lint checks, re-running lint on the full vault may flag pre-existing pages that predate the new rule — treat these as legitimate findings, not false positives.
3. If `log_rotate_needed` is present and the user consents, run `skillwiki log-rotate <vault> --apply`. Otherwise leave alone.
4. **Post-migration verification**: If the user recently migrated content (e.g., moved entity/concept pages to another vault), re-run lint and verify that broken_wikilinks count decreased. Remaining broken links for migrated content indicate pages still referencing the moved files — these should be cleaned up (remove citations or migrate the referencing pages too).
5. Append one `log.md` entry summarizing the lint counts (errors/warnings/info).
## Stop conditions
None — lint reports all findings even on per-page errors.
## Forbidden
- Auto-rotating logs.
- Auto-updating sha256 fields.
- Modifying any page beyond the lint summary entry in `log.md`.
