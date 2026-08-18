---
name: wiki-freshness-repair
description: Repair stale vault sources end to end. Consumes skillwiki drift --affected-pages, re-ingests changed sources through wiki-reingest, then republishes the affected typed pages through the page publish approval flow. Attended only; never auto-repairs.
---

# wiki-freshness-repair

## When This Skill Activates

- A `skillwiki drift --affected-pages` report lists typed pages citing drifted raw sources and the user wants them repaired.
- User explicitly asks to repair stale sources or refresh pages that cite changed sources.
- Attended post-drift maintenance; scheduled/headless runs are report-only.

## Output language

Run `skillwiki lang` at the start. Generate log entries in the resolved language.

## Pre-orientation reads

Standard four reads (SCHEMA, index, log, project context if applicable).

## Input contract

`skillwiki drift --affected-pages [vault]` emits the normal drift report where
every drifted entry additionally carries `affected_pages: string[]` —
vault-relative paths of typed pages that cite the drifted raw source (via body
`^[raw/...]` citation markers and `sources:` frontmatter). An empty array means
the drifted source has no citing pages: raw-only repair, no republish step.

## Steps

0. Resolve vault: `skillwiki path` and `skillwiki lang`.
1. Run `skillwiki drift --affected-pages [vault]`. Read the JSON output.
2. Present findings grouped by status, exactly as wiki-reingest does:
   - **drifted:** source content changed. Show stored vs current sha256 AND the
     `affected_pages` list per source.
   - **identity_conflicts:** STOP and surface; a human chooses the correct
     source/filename pair before any repair.
   - **fetch_failed:** show error details.
   - **unchanged:** no action needed.
3. Report-only is the default. Present the repair plan: per drifted source, the
   new capture to create and the affected pages that would be republished.
4. For each drifted source the user explicitly approves:
   a. Follow wiki-reingest steps 5a–5c: create the updated content as a NEW raw
      capture and verify it; preview `skillwiki archive <exact-old-raw-path>`;
      apply only with the live `--apply --approve <token>` flow. Old bytes move
      to `raw/archived/<category>/...` and are never rewritten.
   b. Update maintained citations to the new capture where editorially required.
   c. For each page in that source's `affected_pages`: re-verify the page
      against the new capture. If the page content must change, republish ONLY
      through `skillwiki page publish <draft> <vault> --target <page>`:
      dry-run first, capture the approval token, then `--write --approve
      "$token"` in one shell chain. A stale token fails with APPROVAL_INVALID —
      re-run the dry-run for a fresh token instead of retrying the old one.
      If the publish returns `held: true`, surface the `hold_reasons`
      (schema-invalid, broken-wikilink, citation-marker-missing) to the user
      and stop for that page; never force a held page.
5. Run `skillwiki audit [vault]` to verify every citation resolves after the
   repairs.
6. Append a log entry summarizing: scanned, drifted, repaired (new captures),
   archived, pages republished, pages skipped/held.

## N9 Compliance

Raw files are immutable (N9). Repairs never modify an existing raw file: the
old raw is preserve-archived and a new raw capture is created with updated
content and sha256, preserving full provenance history.

## Hard boundary (third-harvest program)

- This skill is ATTENDED ONLY. Never run repairs from scheduled or headless
  maintenance; those runs stop after step 3 (the report).
- The third-harvest program shipped this skill with parse-only validation
  against a dry-run `drift --affected-pages` report. Zero live repairs were
  performed as part of program delivery; the first real repair run happens
  only when the user invokes this skill attended.

## Stop conditions

- `skillwiki drift` returns a non-zero exit code other than DRIFT_DETECTED.
- User declines all repair actions.
- A source is listed under `identity_conflicts` (needs a human decision first).
- Page publish dry-run fails or the publish returns held (surface, do not
  force).

## Forbidden

- Modifying files in `raw/` directly (N9).
- Repairing any source without explicit per-source user approval.
- Writing or editing typed pages directly — always the page publish flow.
- Retrying `--write --approve` with a stale approval token.
- Running raw structural apply from scheduled or headless maintenance.
- Re-ingesting a source whose fetched content contains live credentials or
  other authenticating secrets (stop and ask, per wiki-reingest).
