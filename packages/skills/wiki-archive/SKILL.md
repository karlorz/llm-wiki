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

## Probe

Same matrix as `using-skillwiki` → **CLI probe and failsafe**: PRIMARY (`skillwiki archive`), FAILSAFE-GIT (hand tombstone + `git mv` to `_archive/` + push), or FAIL CLOSED.

## Steps (PRIMARY)

0. Resolve vault: `skillwiki path` and `skillwiki lang`.
1. Identify the target page. Confirm with the user which page to archive (show full relPath).
2. Run `skillwiki archive <page> [vault]`. On a vault-sync leaf host where S3 stale originals must be pruned, use `skillwiki archive <page> [vault] --remote seaweed-wiki:cloud/wiki --remote-delete --max-remote-deletes 1` only when that remote path deletion is explicitly intended. Read the JSON output. Successful archive **always** writes a live-path tombstone under `meta/delete-intents/` so snapshot cannot resurrect the live key.
3. Verify with `skillwiki index-check [vault]` — confirm no ghost entries remain.
4. Run `skillwiki lint [vault]` — check for broken wikilinks from other pages that still reference the archived page. If found, update those pages to point to the replacement or remove the stale link.
5. **Raw file archiving (N9 Reingest Protocol only):** When archiving a `raw/` file due to content drift, update ALL `^[raw/...]` citation markers and `sources:` frontmatter entries that reference the old path. Change `raw/articles/foo.md` to `_archive/raw/articles/foo.md` in every referencing page. Verify with `skillwiki audit` that no broken markers remain.
6. Append a `log.md` entry: `## [{date}] archive | {relPath} → _archive/{subdir}/`.
7. Commit/push so tombstone + archive land on private `main`.

## FAILSAFE-GIT (no skillwiki)

1. Confirm path. Write `meta/delete-intents/<slug>.json` with `action: "archive"`, `source: "failsafe-git"`, schema `vault-delete-intent/v1`.
2. `git mv` live path → `_archive/<same relPath>` (create dirs as needed); update `index.md` if typed.
3. Commit with `Delete-Intent` / `Delete-Source: failsafe-git` trailers; push to private `main`.
4. Optional single-path `rclone deletefile` for the **live** path if remote configured.

## Reversibility

Archiving is locally reversible: move the file back from `_archive/` to its original directory, re-add the wikilink entry to `index.md`, and **delete the matching tombstone** under `meta/delete-intents/`. If `--remote-delete` was used, the stale active-path object is pruned from the remote after the archive move, but the archived copy remains and a restore will republish the active path on the next push once the tombstone is cleared.

## Stop conditions

- `skillwiki archive` returns non-zero exit code (page not found, already archived, invalid vault).
- FAIL CLOSED when neither CLI nor private git/gh access is available.
- User declines to proceed.

## Forbidden

- Archiving `raw/` files outside the N9 Reingest Protocol (raw is immutable except during content-drift reingestion).
- Archiving raw files without updating all `^[raw/...]` citation markers that reference them.
- Archiving without user confirmation.
- Deleting local vault files with bare `rm` / bare `git rm` without a delete-intent tombstone (causes snapshot resurrection).
- Remote stale-path pruning only via explicit `skillwiki archive --remote ... --remote-delete` (PRIMARY) or bounded single-path rclone in FAILSAFE-GIT.
