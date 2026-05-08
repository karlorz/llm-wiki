---
version: 0.2.1
name: wiki-audit
description: Verify per-page that every ^[raw/...] resolves and sources frontmatter matches the body.
---

# wiki-audit

## When This Skill Activates

- User asks for a per-page audit or invokes a pre-merge gate.
- A vault is resolvable (see step 0).

## Output language

Run `skillwiki lang` at the start. Generate audit narrative and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.

## Pre-orientation reads
Standard four reads.

## Steps
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
1. `skillwiki audit <page>`. Read the JSON report.
2. Reason over the report:
   - For each unresolved marker: suggest ingesting the missing source or correcting the path.
   - For each `unused_sources` entry: suggest adding a body marker or removing from `sources:`.
   - For each `missing_from_sources` entry: suggest adding to `sources:`.
3. Append one `log.md` entry summarizing the audit and any suggested follow-ups.

## Stop conditions
None — audit always completes.

## Forbidden
- Auto-applying suggested fixes (audit is observation-only).
