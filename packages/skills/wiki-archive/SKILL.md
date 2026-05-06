---
name: wiki-archive
description: Archive a superseded typed-knowledge page. Moves page to _archive/, removes from index.md, logs the action.
---

# wiki-archive

## When This Skill Activates

- User wants to retire, supersede, or remove a typed-knowledge page from active use.
- A page has been replaced by a newer version and should be kept for reference but excluded from lint and queries.

## Output language

Run `skillwiki lang` at the start. Generate log entries in the resolved language.

## Pre-orientation reads

Standard four reads (SCHEMA, index, log, project context if applicable).

## Steps

0. Resolve vault: `skillwiki path` and `skillwiki lang`.
1. Identify the target page. Confirm with the user which page to archive (show full relPath).
2. Run `skillwiki archive <page> [vault]`. Read the JSON output.
3. Verify with `skillwiki index-check [vault]` — confirm no ghost entries remain.
4. Run `skillwiki lint [vault]` — check for broken wikilinks from other pages that still reference the archived page. If found, update those pages to point to the replacement or remove the stale link.
5. Append a `log.md` entry: `## [{date}] archive | {relPath} → _archive/{subdir}/`.

## Reversibility

Archiving is reversible: move the file back from `_archive/` to its original directory and re-add the wikilink entry to `index.md`. No data is deleted.

## Stop conditions

- `skillwiki archive` returns non-zero exit code (page not found, already archived, invalid vault).
- User declines to proceed.

## Forbidden

- Archiving `raw/` files (N9 — raw is immutable).
- Archiving without user confirmation.
- Deleting files (archive moves, never deletes).
