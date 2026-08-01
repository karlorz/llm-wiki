---
name: wiki-reingest
description: Detect and act on source drift. Runs skillwiki drift, reviews changes, archives old raw + ingests new content.
---

# wiki-reingest

## When This Skill Activates

- User wants to check if any vault sources have changed since ingestion.
- Periodic drift check during lint or maintenance cycles; scheduled/headless runs report only.
- User explicitly asks to re-ingest a specific source.

## Output language

Run `skillwiki lang` at the start. Generate log entries in the resolved language.

## Pre-orientation reads

Standard four reads (SCHEMA, index, log, project context if applicable).

## Steps

0. Resolve vault: `skillwiki path` and `skillwiki lang`.
1. Run `skillwiki drift [vault]`. Read the JSON output.
2. Present findings grouped by status:
   - **drifted:** Source content has changed. Show stored vs current sha256.
   - **identity_conflicts:** The fetched source no longer matches the raw filename/source identity. STOP and surface the conflict. Do not archive or reingest until a human chooses the correct source/filename pair.
   - **fetch_failed:** Could not re-fetch. Show error details.
   - **unchanged:** No action needed.
3. Report-only is the default. `skillwiki drift --apply` must not rewrite raw hashes or content; it reports the need for a new capture.
4. For each drifted source, ask the user whether to create a new capture and preserve-archive the old address, or skip.
5. If the user explicitly approves one source:
   a. Follow `wiki-ingest` to create the updated content as a **new** raw capture. Verify it before changing the old address.
   b. Preview `skillwiki archive <exact-old-raw-path>`.
   c. Apply only with the live `--apply --approve <token>` flow. The old complete bytes move to `raw/archived/<category>/...`; they are never rewritten.
   d. Update maintained concept/entity pages to cite the new capture where the editorial meaning requires it. Relocation history continues to resolve the old archived evidence.
6. Append a log event/entry summarizing: scanned, drifted, newly captured, archived, skipped.

## N9 Compliance

Raw files are immutable (N9). Re-ingest never modifies an existing raw file. Instead:
- Preserve the old raw file under `raw/archived/<category>/` through the attended structural transaction.
- Create a new raw file with updated content and new sha256.
- This preserves full provenance history.

## Stop conditions

- `skillwiki drift` returns non-zero exit code other than DRIFT_DETECTED.
- User declines all re-ingest actions.
- No raw sources have `source_url` (nothing to check).

## Forbidden

- Modifying files in `raw/` directly (N9).
- Writing new archives to legacy `_archive/raw/`.
- Running raw structural apply from scheduled or headless maintenance.
- Re-ingesting without user approval for each drifted source.
- Re-ingesting a source listed under `identity_conflicts` without explicit user approval and a corrected target filename/source URL.
- Skipping the drift check and assuming sources have changed.
