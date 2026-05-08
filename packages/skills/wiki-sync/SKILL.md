---
version: 0.2.1
name: wiki-sync
description: Safely sync the vault git repository. Runs skillwiki sync status, then guides push or pull with lint guards and conflict resolution.
---

# wiki-sync

## When This Skill Activates

- User wants to push local vault changes to the remote.
- User wants to pull remote changes into their local vault.
- User asks about vault sync status, git state, or multi-device coordination.
- Periodic maintenance before or after editing sessions.

## Pre-orientation reads

Standard four reads.

## Steps

0. Resolve vault: `skillwiki path` (record source for context).
1. Run `skillwiki sync status <vault>`. Read the JSON output.
   - Exit code 0: vault is clean (nothing to sync).
   - Exit code 22: warnings — dirty/ahead/behind (needs action).
2. Present the current state: `status`, `dirty`, `ahead`, `behind`, `last_commit`.
3. Ask the user which operation they want: **push**, **pull**, or **both** (pull then push).

### Push workflow

4. If vault is dirty, ask the user to review uncommitted changes before proceeding.
5. Run `skillwiki lint <vault>`. If errors exist, stop and report — do not push lint errors to remote.
6. If lint passes (errors = 0), stage and commit:
   - `git -C <vault> add -A`
   - `git -C <vault> commit -m "sync: vault update $(date -u +%Y-%m-%dT%H:%MZ)"`
7. Run `git -C <vault> push origin HEAD`. Report result.
8. Append one `log.md` entry summarizing: files pushed, lint result, commit hash.

### Pull workflow

9. If vault is dirty, stash first: `git -C <vault> stash push -m "auto-stash before pull $(date -u +%Y-%m-%dT%H:%MZ)"`.
10. Run `git -C <vault> pull --rebase origin HEAD`. Report result.
11. If a stash was created, pop it: `git -C <vault> stash pop`.
12. If conflicts occur during stash pop, identify them and present to the user for resolution (see Conflict Resolution below).
13. Run `skillwiki lint <vault>` after pull to verify vault integrity.
14. Append one `log.md` entry summarizing: commits pulled, lint result, any conflicts.

### Pull-then-push workflow

15. Execute the pull workflow (steps 9-13) first.
16. Then execute the push workflow (steps 4-8).

## Conflict Resolution

When merge conflicts are detected:

- **Frontmatter conflicts:**
  - For `updated:` fields: always take the newer timestamp (compare both sides, keep the later one).
  - For all other frontmatter fields: present both versions to the user and ask which to keep.
- **Body conflicts:**
  - Do not auto-resolve body conflicts.
  - Mark unresolved regions with `???` on a line by itself between the conflicting versions, so the user can see both sides and decide.
  - Example:
    ```
    Content from local version
    ???
    Content from remote version
    ```
- After resolving conflicts, run `skillwiki lint <vault>` to verify before committing.

## Multi-device coordination

When the user mentions editing from Obsidian desktop and Claude Code on a server (or any two-device setup):

- Recommend pulling before every editing session on each device.
- Recommend pushing after every editing session on each device.
- If both devices edit the same page between syncs, conflicts are inevitable — the Conflict Resolution section handles this.
- Suggest enabling auto-commit in Obsidian (Community Plugins: `obsidian-git`) to reduce dirty-state drift.

## Stop conditions

- `skillwiki sync status` reports `not_a_repo` — the vault is not a git repository. Advise the user to initialize one.
- Lint errors are found before a push — do not push until resolved.
- `git push` or `git pull` fails with a network error — report and stop.

## Forbidden

- Pushing when lint errors exist.
- Auto-resolving body conflicts without user review.
- Force-pushing (`git push --force`).
- Modifying files in `raw/` to resolve conflicts (N9 — archive and re-ingest instead).
