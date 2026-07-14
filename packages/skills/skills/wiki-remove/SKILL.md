---
name: wiki-remove
description: Hard-delete a vault path with a durable delete-intent tombstone so S3+snapshot cannot resurrect it. Prefer skillwiki remove; if CLI missing, failsafe-git via private GitHub.
---

# wiki-remove

## When This Skill Activates

- User wants to permanently remove a vault path (not archive-for-reference).
- Cleanup of stale pages that should not return via snapshot resurrection.
- User says hard delete, remove for real, stop resurrecting.

## Output language

If `skillwiki` is available: run `skillwiki lang` at the start. Otherwise default to English log prose.

## Pre-orientation

Read SCHEMA/index only as needed. Confirm full vault-relative path with the user before delete.

## Probe (required)

1. `command -v skillwiki && skillwiki remove --help`
2. `git -C <vault> rev-parse --is-inside-work-tree` and `git remote get-url origin` (expect private `karlorz/wiki` / fleet `vault_remote`)
3. Auth: `gh auth status` **or** `git ls-remote origin HEAD`

| Result | Mode |
|--------|------|
| skillwiki OK | **PRIMARY** |
| skillwiki fail, git/gh + private repo OK | **FAILSAFE-GIT** |
| neither | **FAIL CLOSED** — stop; never bare `rm` for fleet effect |

Do not auto `npm install -g skillwiki` in headless/goal/satellite sessions.

## PRIMARY steps

1. Resolve vault: `skillwiki path`.
2. Confirm path with user.
3. On a vault-sync leaf when S3 prune is intentional:
   `skillwiki remove <page> [vault] --remote seaweed-wiki:cloud/wiki --remote-delete --max-remote-deletes 1 --reason "<text>"`
   Otherwise: `skillwiki remove <page> [vault] --reason "<text>"`
4. Read JSON: expect `tombstone_path` under `meta/delete-intents/`, `removed` set.
5. Commit + push via normal wiki-sync / git (tombstone + deletion must reach private `main` for durability).
6. Report MODE=primary, paths, and whether remote-delete ran.

## FAILSAFE-GIT steps (no skillwiki CLI)

Agent **must** have git (and preferably gh) access to private vault remote.

1. Confirm path with user. Set `PATH_REL` (vault-relative, no `..`).
2. Write tombstone `meta/delete-intents/<slug>.json` where slug is path with `/` → `__`, e.g. `summaries/foo.md` → `summaries__foo.md.json`:

```json
{
  "schema": "vault-delete-intent/v1",
  "path": "PATH_REL",
  "action": "remove",
  "created": "ISO-8601-UTC",
  "host": "SKILLWIKI_HOST_ID-or-unknown",
  "actor": "agent-failsafe-git",
  "reason": "user requested remove; skillwiki CLI unavailable",
  "source": "failsafe-git",
  "expires": null
}
```

3. Delete local file at `PATH_REL` (and index line for `[[slug]]` if typed page).
4. `git add` tombstone + path change; commit with trailers:

```text
Delete-Intent: PATH_REL
Delete-Source: failsafe-git
```

5. `git pull --rebase origin main` (or merge fallback per vault-sync ADR) then **`git push origin HEAD:main`**. Require successful push before claiming durable success.
6. Optional: if `rclone` and `WIKI_REMOTE` exist: `rclone deletefile "$WIKI_REMOTE/PATH_REL"` (single path only).
7. Report `MODE=failsafe-git`, commit SHA, `S3_PRUNE=done|deferred`.

## Stop conditions

- User declines.
- FAIL CLOSED (no CLI and no private git access).
- Push to private wiki fails.
- Path invalid or under `_archive/` without explicit restore/remove policy.

## Forbidden

- Bare `rm` / bare `git rm` without tombstone.
- Force-push.
- Unbounded `rclone sync` / mass remote delete.
- Claiming fleet delete complete without tombstone on `origin/main` (and push success).

## Reversibility

Hard remove is not locally reversible from `_archive`. Restore requires re-authoring content and deleting the tombstone file under `meta/delete-intents/`, then normal push.
