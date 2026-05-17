     1|     1|---
     2|     2|version: 0.2.2
     3|     3|name: wiki-lint
     4|     4|description: Vault health check via the umbrella `skillwiki lint` subcommand. Read-only by default; rotation requires explicit user consent.
     5|     5|---
     6|     6|
     7|     7|# wiki-lint
     8|     8|
     9|     9|## When This Skill Activates
    10|    10|
    11|    11|- User asks for a vault health report, lint, or audit.
    12|    12|- Periodic maintenance.
    13|    13|
    14|    14|## Pre-orientation reads
    15|    15|
    16|    16|Standard four reads.
    17|    17|
    18|    18|## Steps
    19|    19|
    20|    20|0. Resolve vault: `skillwiki path` (record source for context).
    21|    21|   - **CRITICAL**: Verify the correct vault when the user has multiple wiki instances (e.g., ~/wiki vs ~/wiki-fin). User may explicitly specify which vault to target — confirm before destructive operations.
    22|    22|1. Run `skillwiki lint <vault>`. Read the JSON.
    23|    23|2. Reason over findings; present grouped by severity with concrete suggested actions per kind. If the CLI was recently updated with new lint checks, re-running lint on the full vault may flag pre-existing pages that predate the new rule — treat these as legitimate findings, not false positives.
    24|    24|3. If `log_rotate_needed` is present and the user consents, run `skillwiki log-rotate <vault> --apply`. Otherwise leave alone.
    25|    25|4. **Post-migration verification**: If the user recently migrated content (e.g., moved entity/concept pages to another vault), re-run lint and verify that broken_wikilinks count decreased. Remaining broken links for migrated content indicate pages still referencing the moved files — these should be cleaned up (remove citations or migrate the referencing pages too).
    26|    26|5. Append one `log.md` entry summarizing the lint counts (errors/warnings/info).
    27|    27|
    28|    28|## Stop conditions
    29|    29|
    30|    30|None — lint reports all findings even on per-page errors.
    31|    31|
    32|    32|## Forbidden
    33|    33|
    34|    34|- Auto-rotating logs.
    35|    35|- Auto-updating sha256 fields.
    36|    36|- Modifying any page beyond the lint summary entry in `log.md`.
    37|    37|
