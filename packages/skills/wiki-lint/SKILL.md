---
name: wiki-lint
description: Vault health check — validation, sha256 drift, orphans/bridges, review queue (E3). Read-only by default.
---

# wiki-lint

## When to invoke
- User asks for a vault health report.
- Periodic maintenance.

## Pre-orientation reads
Standard four reads.

## Steps (in order)
1. For each typed-knowledge page: `npx skillwiki validate <page>`. Collect errors.
2. For each `raw/` file: `npx skillwiki hash <file>`. Compare to frontmatter `sha256:`. Flag drift WITHOUT auto-update (per N9).
3. `npx skillwiki orphans <vault>`. Collect orphans + bridge nodes.
4. **Review queue (E3).** Build a section listing:
   - Pages with `confidence: low` AND single `sources:` entry → "promote or corroborate".
   - Pages with `contested: true` → "resolve contradiction".
   - Orphan clusters → "knowledge gap".
   - Bridge nodes → "fragility risk".
5. Write a single `log.md` rotation entry summarizing counts.
6. Print the report (terminal-friendly).

## Stop conditions
None — lint reports all findings even on per-page errors.

## Forbidden
- Auto-updating sha256 fields.
- Modifying pages other than `log.md` rotation.
