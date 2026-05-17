     1|---
     2|version: 0.2.1
     3|name: wiki-sync
     4|description: Safely sync the vault git repository. Runs skillwiki sync status, then guides push or pull with lint guards and conflict resolution.
     5|---
     6|
     7|# wiki-sync
     8|
     9|## When This Skill Activates
    10|
    11|- User wants to push local vault changes to the remote.
    12|- User wants to pull remote changes into their local vault.
    13|- User asks about vault sync status, git state, or multi-device coordination.
    14|- Periodic maintenance before or after editing sessions.
    15|
    16|## Pre-orientation reads
    17|
    18|Standard four reads.
    19|
    20|## Steps
    21|
    22|0. Resolve vault: `skillwiki path` (record source for context).
    23|1. Run `skillwiki sync status <vault>`. Read the JSON output.
    24|   - Exit code 0: vault is clean (nothing to sync).
    25|   - Exit code 22: warnings — dirty/ahead/behind (needs action).
    26|2. Present the current state: `status`, `dirty`, `ahead`, `behind`, `last_commit`.
    27|3. Ask the user which operation they want: **push**, **pull**, or **both** (pull then push).
    28|
    29|### Push workflow
    30|
    31|4. If vault is dirty, ask the user to review uncommitted changes before proceeding.
    32|5. Run `skillwiki lint <vault>`. If errors exist, stop and report — do not push lint errors to remote.
    33|6. If lint passes (errors = 0), stage and commit:
    34|   - `git -C <vault> add -A`
    35|   - `git -C <vault> commit -m "sync: vault update $(date -u +%Y-%m-%dT%H:%MZ)"`
    36|7. Run `git -C <vault> push origin HEAD`. Report result.
    37|8. Append one `log.md` entry summarizing: files pushed, lint result, commit hash.
    38|
    39|### Pull workflow
    40|
    41|9. If vault is dirty, stash first: `git -C <vault> stash push -m "auto-stash before pull $(date -u +%Y-%m-%dT%H:%MZ)"`.
    42|10. Run `git -C <vault> pull --rebase origin HEAD`. Report result.
    43|11. If a stash was created, pop it: `git -C <vault> stash pop`.
    44|12. If conflicts occur during stash pop, identify them and present to the user for resolution (see Conflict Resolution below).
    45|13. Run `skillwiki lint <vault>` after pull to verify vault integrity.
    46|14. Append one `log.md` entry summarizing: commits pulled, lint result, any conflicts.
    47|
    48|### Pull-then-push workflow
    49|
    50|15. Execute the pull workflow (steps 9-13) first.
    51|16. Then execute the push workflow (steps 4-8).
    52|
    53|## Conflict Resolution
    54|
    55|When merge conflicts are detected:
    56|
    57|- **Frontmatter conflicts:**
    58|  - For `updated:` fields: always take the newer timestamp (compare both sides, keep the later one).
    59|  - For all other frontmatter fields: present both versions to the user and ask which to keep.
    60|- **Body conflicts:**
    61|  - Do not auto-resolve body conflicts.
    62|  - Mark unresolved regions with `???` on a line by itself between the conflicting versions, so the user can see both sides and decide.
    63|  - Example:
    64|    ```
    65|    Content from local version
    66|    ???
    67|    Content from remote version
    68|    ```
    69|- After resolving conflicts, run `skillwiki lint <vault>` to verify before committing.
    70|
    71|## Multi-device coordination
    72|
    73|When the user mentions editing from Obsidian desktop and Claude Code on a server (or any two-device setup):
    74|
    75|- Recommend pulling before every editing session on each device.
    76|- Recommend pushing after every editing session on each device.
    77|- If both devices edit the same page between syncs, conflicts are inevitable — the Conflict Resolution section handles this.
    78|- Suggest enabling auto-commit in Obsidian (Community Plugins: `obsidian-git`) to reduce dirty-state drift.
    79|
    80|## Rclone-backed vault with git snapshotting (cron pattern)
    81|
    82|Some deployments use a cloud-backed vault (`rclone mount`) with a separate git repository for versioned snapshots. This pattern separates "live working vault" from "versioned backup".
    83|
    84|### Architecture
    85|
    86|```
    87|~/wiki           → rclone mount to cloud storage (S3/IDrive/etc) — live vault
    88|~/wiki-git       → git repository cloned from GitHub — snapshot target
    89|cron hourly      → rsync ~/wiki/ → ~/wiki-git/ → git commit → git push
    90|```
    91|
    92|### Implementation (wiki-snapshot.sh)
    93|
    94|```bash
    95|#!/bin/bash
    96|WIKI_DIR="/root/wiki"
    97|GIT_DIR="/root/wiki-git"
    98|DATE=$(date +%Y%m%d_%H%M%S)
    99|
   100|# Sync from rclone mount to git repo (quiet mode for slow mounts)
   101|rsync -a --delete -q \
   102|    --exclude='.snapshots' --exclude='.git' --exclude='.obsidian' --exclude='.skillwiki' \
   103|    "$WIKI_DIR/" "$GIT_DIR/"
   104|
   105|cd "$GIT_DIR" || exit 1
   106|git config user.email "cron@hermes.local"
   107|git config user.name "Hermes Snapshot"
   108|
   109|# Check for changes
   110|if [ -z "$(git status --porcelain)" ]; then
   111|    exit 0  # Nothing to commit
   112|fi
   113|
   114|git add -A
   115|git commit -m "Snapshot $DATE"
   116|
   117|# Pull with rebase to handle remote changes (e.g., README edits on GitHub)
   118|if ! git pull --rebase origin main 2>/dev/null; then
   119|    git pull origin main 2>/dev/null || true
   120|fi
   121|
   122|git push origin main || echo "Push failed"
   123|```
   124|
   125|### Pitfalls specific to this pattern
   126|
   127|1. **Divergent branches from external pushes**: If something else pushes to the same GitHub repo (manual edits from macOS desktop, GitHub web UI edits, another server), the local `~/wiki-git` will diverge. The `--rebase` flag handles most cases, but if commits conflict:
   128|   ```bash
   129|   cd ~/wiki-git
   130|   git rebase --abort 2>/dev/null || true
   131|   git fetch origin main
   132|   git reset --hard origin/main
   133|   bash ~/.hermes/scripts/wiki-snapshot.sh  # Re-sync fresh
   134|   ```
   135|   
   136|   **Prevention**: Avoid editing the GitHub repo directly via web interface or uncoordinated clones. The canonical flow is:
   137|   - Server: rclone mount → rsync → git commit → git push
   138|   - macOS/desktop: git pull → edit → git commit → git push → server pulls on next cron
   139|
   140|2. **Slow rsync on rclone mounts**: The rclone FUSE mount can be slow for large directory listings. Use `rsync -q` (quiet) to reduce output overhead, and consider `--delete-delay` instead of `--delete` if file churn is high. The rclone mount latency can cause `du` and `find` operations to timeout — this is normal, not an error.
   141|
   142|3. **Golden Rule violation**: Never mix sync methods on the same vault. If using rclone mount + git snapshotting, do NOT also enable Obsidian Sync, Syncthing, or iCloud on `~/wiki`. The rclone mount IS the sync mechanism.
   143|
   144|4. **Credential exposure**: The rclone mount and git remote use different credentials. Ensure git credentials are cached or use HTTPS with token, but never commit rclone config to git.
   145|
   146|## Stop conditions
   147|
   148|- `skillwiki sync status` reports `not_a_repo` — the vault is not a git repository. Advise the user to initialize one.
   149|- Lint errors are found before a push — do not push until resolved.
   150|- `git push` or `git pull` fails with a network error — report and stop.
   151|
   152|## Forbidden
   153|
   154|- Pushing when lint errors exist.
   155|- Auto-resolving body conflicts without user review.
   156|- Force-pushing (`git push --force`).
   157|- Modifying files in `raw/` to resolve conflicts (N9 — archive and re-ingest instead).
   158|