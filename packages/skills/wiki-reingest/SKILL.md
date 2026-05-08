---
version: 0.2.1
name: wiki-reingest
description: Detect and act on source drift. Runs skillwiki drift, reviews changes, archives old raw + ingests new content.
---

# wiki-reingest

## When This Skill Activates

- User wants to check if any vault sources have changed since ingestion.
- Periodic drift check during lint or maintenance cycles.
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
   - **fetch_failed:** Could not re-fetch. Show error details.
   - **unchanged:** No action needed.
3. For each drifted source, ask the user: archive old + ingest new, or skip?
4. If the user approves re-ingest for a source:
   a. Run `skillwiki archive <raw-path>` to archive the old raw file.
   b. Follow the `wiki-ingest` skill to ingest the updated content as a new raw file.
   c. Update any concept/entity pages that cite the old source to reference the new one.
5. Append a `log.md` entry summarizing: scanned, drifted, re-ingested, skipped.

## N9 Compliance

Raw files are immutable (N9). Re-ingest never modifies an existing raw file. Instead:
- Archive the old raw file (moves to `_archive/raw/`).
- Create a new raw file with updated content and new sha256.
- This preserves full provenance history.

## Stop conditions

- `skillwiki drift` returns non-zero exit code other than DRIFT_DETECTED.
- User declines all re-ingest actions.
- No raw sources have `source_url` (nothing to check).

## Forbidden

- Modifying files in `raw/` directly (N9).
- Re-ingesting without user approval for each drifted source.
- Skipping the drift check and assuming sources have changed.
