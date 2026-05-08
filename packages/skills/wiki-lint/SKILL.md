---
version: 0.2.1
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
1. Run `skillwiki lint <vault>`. Read the JSON.
2. Reason over findings; present grouped by severity with concrete suggested actions per kind. If the CLI was recently updated with new lint checks, re-running lint on the full vault may flag pre-existing pages that predate the new rule — treat these as legitimate findings, not false positives.
3. If `log_rotate_needed` is present and the user consents, run `skillwiki log-rotate <vault> --apply`. Otherwise leave alone.
4. Append one `log.md` entry summarizing the lint counts (errors/warnings/info).

## Stop conditions

None — lint reports all findings even on per-page errors.

## Forbidden

- Auto-rotating logs.
- Auto-updating sha256 fields.
- Modifying any page beyond the lint summary entry in `log.md`.
