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
## Forbidden
- Pushing when lint errors exist.
- Auto-resolving body conflicts without user review.
- Force-pushing (`git push --force`).
- Modifying files in `raw/` to resolve conflicts (N9 — archive and re-ingest instead).
