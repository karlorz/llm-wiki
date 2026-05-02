---
name: wiki-audit
description: Verify per-page that every ^[raw/...] resolves and sources frontmatter matches the body.
---

# wiki-audit

## When to invoke
- User asks to audit a specific page.
- Pre-merge gate on a synthesis-heavy page.

## Pre-orientation reads
Standard four reads.

## Steps
1. `npx skillwiki audit <page>`. Read the JSON report.
2. Reason over the report:
   - For each unresolved marker: suggest ingesting the missing source or correcting the path.
   - For each `unused_sources` entry: suggest adding a body marker or removing from `sources:`.
   - For each `missing_from_sources` entry: suggest adding to `sources:`.
3. Append one `log.md` entry summarizing the audit and any suggested follow-ups.

## Stop conditions
None — audit always completes.

## Forbidden
- Auto-applying suggested fixes (audit is observation-only).
