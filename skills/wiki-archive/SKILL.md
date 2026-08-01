---
name: wiki-archive
description: Archive a superseded typed page or preserve-move an exact raw source through the attended lifecycle workflow.
---

# wiki-archive

## When This Skill Activates

- User wants to retire, supersede, or remove a typed-knowledge page from active use.
- A page has been replaced by a newer version and should be kept for reference but excluded from active use.
- The user explicitly requests a structural archive of one exact raw source while preserving its bytes under `raw/`.

## Output language

Run `skillwiki lang` at the start. Generate log entries in the resolved language.

## Pre-orientation reads

Standard four reads (SCHEMA, index, log, project context if applicable).

## Probe

Same matrix as `using-skillwiki` → **CLI probe and failsafe**. FAILSAFE-GIT is permitted for typed pages only. Raw archive requires the SkillWiki attended approval flow; if it is unavailable, fail closed.

## Steps (PRIMARY)

0. Resolve vault: `skillwiki path` and `skillwiki lang`.
1. Identify the target page and show its full vault-relative path. Raw targets must be exact `raw/...` paths; basename inference is refused.
2. For a typed page, run `skillwiki archive <page> [vault]` using the normal managed mutation workflow.
3. For a raw article, paper, or transcript:
   1. Run `skillwiki archive <exact-raw-path> [vault]` and inspect the dry-run, destination, complete-file hash, citation impact, and state-bound approval token.
   2. If the user approves that exact live plan, run the identical command with `--apply --approve <token>`.
   3. The destination is `raw/archived/<category>/...`. The command copies exclusively, verifies complete-file SHA-256, retires the old address, records append-only relocation history, and leaves the raw bytes unchanged.
   4. Maintained citations may be rewritten to the new address; historical addresses also resolve through relocation history. Legacy `_archive/raw/` is read-compatible only and is never a new-write destination.
4. On a vault-sync leaf where remote stale-path pruning is explicitly intended, add `--remote ... --remote-delete --max-remote-deletes 1`. This prunes only the retired address; the preserved raw destination remains.
5. Verify with `skillwiki index-check [vault]`, `skillwiki lint [vault]`, and `skillwiki audit <referencing-page>` where applicable.
6. Commit/push through the normal vault-sync workflow so the tombstone, preserved destination, and relocation event land together.

## FAILSAFE-GIT (no skillwiki)

1. Confirm the target is not under `raw/`. Raw preserve-moves fail closed without the CLI transaction.
2. Write `meta/delete-intents/<slug>.json` with `action: "archive"`, `source: "failsafe-git"`, schema `vault-delete-intent/v1`.
3. `git mv` the typed page to `_archive/<same relPath>`; update `index.md`.
4. Commit with `Delete-Intent` / `Delete-Source: failsafe-git` trailers; push to private `main`.

## Reversibility

Typed archiving is locally reversible from `_archive/`. Raw archive is reversible only through another attended preserve-move that keeps exact bytes under `raw/`; do not hand-edit or recreate the source at its old address.

## Stop conditions

- `skillwiki archive` returns non-zero exit code (page not found, already archived, invalid vault).
- FAIL CLOSED when neither CLI nor private git/gh access is available.
- User declines to proceed.

## Forbidden

- Rewriting raw content or frontmatter during archive.
- Moving raw evidence outside `raw/`, including new writes to `_archive/raw/`.
- Moving `raw/assets/**` as a side effect of source archive; referenced asset paths stay frozen.
- Applying a raw archive without a fresh state-bound token and attended explicit invocation.
- Deleting local vault files with bare `rm` / bare `git rm` without a delete-intent tombstone (causes snapshot resurrection).
- Remote stale-path pruning only via explicit `skillwiki archive --remote ... --remote-delete` (PRIMARY) or bounded single-path rclone in FAILSAFE-GIT.
