---
version: 0.3.0
name: wiki-sync
description: Safely sync the vault git repository — multi-session safe via advisory lockfile. Runs skillwiki sync status, then guides push or pull with lint guards and conflict resolution.
---
# wiki-sync
## When This Skill Activates
- User wants to push local vault changes to the remote.
- User wants to pull remote changes into their local vault.
- User asks about vault sync status, git state, or multi-device coordination.
- Multiple Claude Code sessions targeting the same vault.
- Periodic maintenance before or after editing sessions.
## Pre-orientation reads
Standard four reads.
## Steps
0. Resolve vault: `skillwiki path` (record source for context).

## Pre-flight peer check (multi-session safe)

**Before any git stash or pull/push operation**, check for peer sessions:

1. Run `skillwiki sync peers <vault>` to detect other sessions with active locks or recent `wiki-sync:*` stashes.
2. If any non-self peer is present (locked or has stashes newer than 5 minutes):
   - Surface the peer's session_id, PID, and summary to the user
   - Ask the user to wait for the peer to finish, or pass `--force` to proceed anyway
   - If `--force` is not given and peer is detected, **abort and exit**
3. Acquire an advisory lock: `skillwiki sync lock <vault> --summary "wiki-sync <op>"` (where `<op>` is "pull" or "push")
   - If lock is held (exit code 48), surface the holder (session_id, PID, summary) and abort
4. **Always pair with unlock on exit** (success or error):
   - `skillwiki sync unlock <vault>` in a finally block or error handler

### Stash backlog warning

On every invocation, count `wiki-sync:*` stashes older than 24 hours via `skillwiki sync peers`:
- If any old stashes exist, warn the user: "Found N wiki-sync stash(es) older than 24h — audit and clean before proceeding"
- **Do not auto-drop old stashes** — the user audits each one

## Sync workflow

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
9. Run `skillwiki sync status <vault> --include-stashes` to check for untracked file collisions (see Untracked file fingerprint below).
10. If vault is dirty, stash first with the identifiable name format:
    ```bash
    VAULT="<vault>"
    SESSION_ID="$(echo $CLAUDE_SESSION_ID)" # or fallback to PID/hostname
    CWD_HASH="$(echo -n "$VAULT" | sha256sum | cut -c1-8)"
    ISO_TS="$(date -u +%Y-%m-%dT%H:%MZ)"
    MSG="wiki-sync:${SESSION_ID}:${CWD_HASH}:${ISO_TS}:pre-pull"
    git -C "$VAULT" stash push -m "$MSG"
    ```
11. Run `git -C <vault> pull --rebase origin HEAD`. Report result.
12. If a stash was created, pop it: `git -C <vault> stash pop`.
13. If conflicts occur during stash pop, identify them and present to the user for resolution (see Conflict Resolution below).
14. Run `skillwiki lint <vault>` after pull to verify vault integrity.
15. Append one `log.md` entry summarizing: commits pulled, lint result, any conflicts.

### Pull-then-push workflow
16. Execute the pull workflow (steps 9-14) first.
17. Then execute the push workflow (steps 4-8).

## Stash naming convention

When `wiki-sync` creates a stash, use the identifiable message format:

```
wiki-sync:{session_id}:{cwd_hash}:{iso8601_timestamp}:{summary}
```

- **session_id**: prefer `$CLAUDE_SESSION_ID` env var if set, else `$$` (shell PID), else `unknown`
- **cwd_hash**: first 8 chars of sha256(`$VAULT` path)
- **iso8601_timestamp**: e.g., `2026-05-23T03:25:00Z` (UTC)
- **summary**: short label like `pre-pull`, `pre-push`, or custom reason

This allows any session to list `git stash list` and identify which stash came from which session/working directory.

## Untracked file fingerprint (pre-pull)

Before `git pull --rebase`, check for untracked files that exist on the remote and may collide:

```bash
for f in $(git -C "$VAULT" ls-files --others --exclude-standard); do
  if git -C "$VAULT" cat-file -e "origin/main:$f" 2>/dev/null; then
    # File exists on remote; check if identical
    if diff -q <(git -C "$VAULT" show "origin/main:$f") "$VAULT/$f" >/dev/null 2>&1; then
      # Byte-identical — safe to remove (presync artifact)
      rm "$VAULT/$f"
    else
      # DIFFERENT — surface to user, DO NOT silently --include-untracked
      echo "UNTRACKED COLLISION: $f differs from origin/main — surface to user for resolution"
    fi
  fi
  # If file does not exist on remote, leave it alone (pull won't touch it)
done
```

If collisions are found (different content), ask the user to resolve manually before pulling.

## Conflict Resolution

When merge conflicts are detected:

### Frontmatter conflicts
- For `updated:` fields: always take the newer timestamp (compare both sides, keep the later one).
- For all other frontmatter fields: present both versions to the user and ask which to keep.

### Body conflicts
- Do not auto-resolve body conflicts.
- Mark unresolved regions with `???` on a line by itself between the conflicting versions, so the user can see both sides and decide.
- Example:
```
Content from local version
???
Content from remote version
```
- After resolving conflicts, run `skillwiki lint <vault>` to verify before committing.

### Modify/delete conflicts

When `git pull --rebase` reports `CONFLICT (modify/delete)`:

1. Identify the commit that deleted the file:
   ```bash
   git -C "$VAULT" log --diff-filter=D --pretty=oneline -- <path>
   ```
2. Read the commit message and any retro / log entry referencing it to determine if the deletion was intentional or accidental.
3. Decide:
   - `git -C "$VAULT" rm <path>` — accept the deletion (rebase continues)
   - `git -C "$VAULT" add <path>` — keep the local restoration (rebase continues)
4. `git -C "$VAULT" rebase --continue`.

## Multi-device coordination
When the user mentions editing from Obsidian desktop and Claude Code on a server (or any two-device setup):
- Recommend pulling before every editing session on each device.
- Recommend pushing after every editing session on each device.
- If both devices edit the same page between syncs, conflicts are inevitable — the Conflict Resolution section handles this.
- Suggest enabling auto-commit in Obsidian (Community Plugins: `obsidian-git`) to reduce dirty-state drift.

## Rclone-backed vault with git snapshotting (cron pattern)
Some deployments use a cloud-backed vault (`rclone mount`) with a separate git repository for versioned snapshots. This pattern separates "live working vault" from "versioned backup".
### Architecture
```
~/wiki           → rclone mount to cloud storage (S3/IDrive/etc) — live vault
~/wiki-git       → git repository cloned from GitHub — snapshot target
cron hourly      → rsync ~/wiki/ → ~/wiki-git/ → git commit → git push
```
### Implementation (wiki-snapshot.sh)
```bash
#!/bin/bash
WIKI_DIR="/root/wiki"
GIT_DIR="/root/wiki-git"
DATE=$(date +%Y%m%d_%H%M%S)
# Sync from rclone mount to git repo (quiet mode for slow mounts)
rsync -a --delete -q \
--exclude='.snapshots' --exclude='.git' --exclude='.obsidian' --exclude='.skillwiki' \
"$WIKI_DIR/" "$GIT_DIR/"
cd "$GIT_DIR" || exit 1
git config user.email "cron@hermes.local"
git config user.name "Hermes Snapshot"
# Check for changes
if [ -z "$(git status --porcelain)" ]; then
exit 0  # Nothing to commit
fi
git add -A
git commit -m "Snapshot $DATE"
# Pull with rebase to handle remote changes (e.g., README edits on GitHub)
if ! git pull --rebase origin main 2>/dev/null; then
git pull origin main 2>/dev/null || true
fi
git push origin main || echo "Push failed"
```
### Pitfalls specific to this pattern
1. **Divergent branches from external pushes**: If something else pushes to the same GitHub repo (manual edits from macOS desktop, GitHub web UI edits, another server), the local `~/wiki-git` will diverge. The `--rebase` flag handles most cases, but if commits conflict:
```bash
cd ~/wiki-git
git rebase --abort 2>/dev/null || true
git fetch origin main
git reset --hard origin/main
bash ~/.hermes/scripts/wiki-snapshot.sh  # Re-sync fresh
```
**Prevention**: Avoid editing the GitHub repo directly via web interface or uncoordinated clones. The canonical flow is:
- Server: rclone mount → rsync → git commit → git push
- macOS/desktop: git pull → edit → git commit → git push → server pulls on next cron
2. **Slow rsync on rclone mounts**: The rclone FUSE mount can be slow for large directory listings. Use `rsync -q` (quiet) to reduce output overhead, and consider `--delete-delay` instead of `--delete` if file churn is high. The rclone mount latency can cause `du` and `find` operations to timeout — this is normal, not an error.
3. **Golden Rule violation**: Never mix sync methods on the same vault. If using rclone mount + git snapshotting, do NOT also enable Obsidian Sync, Syncthing, or iCloud on `~/wiki`. The rclone mount IS the sync mechanism.
4. **Credential exposure**: The rclone mount and git remote use different credentials. Ensure git credentials are cached or use HTTPS with token, but never commit rclone config to git.

## Stop conditions
- `skillwiki sync status` reports `not_a_repo` — the vault is not a git repository. Advise the user to initialize one.
- Lint errors are found before a push — do not push until resolved.
- `git push` or `git pull` fails with a network error — report and stop.
- Peer lock is held or peer stashes exist — abort and ask the user to wait or pass `--force`.
- Untracked file collision detected on pull — surface to user for manual resolution.

## Forbidden
- Pushing when lint errors exist.
- Auto-resolving body conflicts without user review.
- Force-pushing (`git push --force`).
- Modifying files in `raw/` to resolve conflicts (N9 — archive and re-ingest instead).
- Stashing without the `wiki-sync:...` name format (breaks peer detection).
- Force-deleting a peer's lockfile (use `--force` only if peer is confirmed dead).
