---
name: wiki-sync
description: Safely sync the vault git repository — multi-session safe via advisory lockfile. Handles rebase conflict storms from archive-commit × snapshot-stream patterns. Runs skillwiki sync status, then guides push or pull with lint guards and conflict resolution.
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
5. Run `skillwiki sync lint-delta <vault> --base-ref origin/main`. Block only when `new_errors > 0`. Report full/base/new/resolved. Malformed delta evidence fails closed — do not push.
6. If lint-delta allows (new_errors = 0), stage and commit:
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
11. Prefer the canonical pull helper (`wiki-pull-with-auto-resolve.sh` / vault-presync `--execute`) so stale-clean rebase state uses recovery-ref + `rebase --quit`, active rebases fail closed, and only fully materialized commits are dropped. If invoking git directly: `git -C <vault> pull --rebase origin HEAD`. Report result.
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

### Rebase conflict storm (archive commits × snapshot stream)

When many local archive-only commits (e.g., `archive: moved X to _archive/`) are rebased over an origin/main that receives frequent snapshot commits (e.g., sg01 `Snapshot YYYYMMDD_HHMMSS`), every archive commit re-triggers the same content conflicts on shared files (`log.md`, `knowledge.md`, `spec.md`). This is predictable and can be resolved systematically.

**Detection**: 3+ consecutive rebase stops on commits whose message matches `^archive: moved`.

**Resolution**: For each archive commit during the storm:

```bash
# Apply --ours to all conflicting files (keep HEAD = origin/main + snapshots)
for f in $(git -C "$VAULT" diff --name-only --diff-filter=U); do
  git -C "$VAULT" checkout --ours "$f" && git -C "$VAULT" add "$f"
done
git -C "$VAULT" rebase --continue
```

**After the storm passes** (non-archive commits or clean rebase), pop the stash and handle any remaining conflicts per the normal Conflict Resolution sections above.

**Prevention**:
- Sync more frequently — don't let local fall >5 commits behind origin/main
- Prefer smaller, attended exact-target archive operations and sync promptly; there is no batch raw-archive apply mode.
- For vaults with snapshot cron, prefer smaller, more frequent syncs over large batch rebases

See `concepts/wiki-sync-rebase-conflict-storm-pattern.md` for detailed analysis.

## Multi-device coordination
When the user mentions editing from Obsidian desktop and Claude Code on a server (or any two-device setup):
- Recommend pulling before every editing session on each device.
- Recommend pushing after every editing session on each device.
- If both devices edit the same page between syncs, conflicts are inevitable — the Conflict Resolution section handles this.
- Suggest enabling auto-commit in Obsidian (Community Plugins: `obsidian-git`) to reduce dirty-state drift.

## Host-aware write and promotion authority

Resolve the live vault with `skillwiki path` first. Then choose the host role:

| Host role | Live vault | Authoring surface | Promotion to GitHub |
| --- | --- | --- | --- |
| Authorized Git-backed leaf (e.g. macOS) | Git vault from `skillwiki path` | Managed SkillWiki publishers against that vault | `skillwiki sync push "$VAULT"` after lint-delta |
| Protected snapshotter (sg01) | `/root/wiki` (rclone FUSE; not a Git repo) | Managed SkillWiki publishers against `/root/wiki` | S3 → `wiki-snapshot.timer` (default) → protected `/root/wiki-git` pipeline → GitHub |

High-signal safety rule:

> Do not author, copy, edit, stage, commit, pull, reset, or push agent changes
> in `/root/wiki-git`.

### Protected snapshotter rules (sg01)

- Author only via managed commands against the live vault (`skillwiki path` → usually `/root/wiki`).
- Do **not** run `skillwiki sync push /root/wiki` (not a Git repo) or `skillwiki sync push /root/wiki-git` (blocked as protected snapshot worktree).
- Do **not** `cd` into `/root/wiki-git` or `~/wiki-git` for ordinary authoring.
- Do **not** rsync, copy, or edit files into the snapshot worktree as an agent/operator workflow.
- Do **not** run `git reset --hard`, direct commits, or manual snapshot scripts to "fix" divergence.
- Promotion is owned by `wiki-snapshot.timer` by default. Publishers never start systemd units.
- `skillwiki work-complete` may finish with `committed=false` on sg01; later snapshot promotion owns the Git commit/push.
- `.skillwiki/work-complete/*.env` journals are local retry hygiene, not GitHub SSOT. Do not treat them as publishable. Prefer last-op pathspecs over a raw `git add -A` when staging a managed completion. Vault `.gitignore` and rclone push filters must exclude `work-complete/` and `last-op.json`.

### Authorized Git leaf rules

- Use managed publication (`skillwiki page publish`, `skillwiki project-page publish`, etc.) against the resolved Git vault.
- Then use this skill's push workflow (`skillwiki sync status` → lint-delta → commit → `skillwiki sync push` / `git push` as documented above).
- Never treat a snapshot worktree mirror as a substitute for the live vault.

### Historical rationale (not executable)

Some older deployments separated a cloud-backed live vault from a Git snapshot worktree. That architecture still exists on protected snapshotters, but the snapshot worktree is **pipeline-internal**. Historical recipes that rsync into the worktree, reset it hard to origin/main, or run snapshot shell scripts by hand are obsolete and must not be copied.

## Stop conditions
- `skillwiki sync status` reports `not_a_repo` — the vault is not a git repository. On protected snapshotters this is expected for the FUSE live path; do not switch to `/root/wiki-git` to force a push.
- Lint errors are found before a push — do not push until resolved.
- `git push` or `git pull` fails with a network error — report and stop.
- Peer lock is held or peer stashes exist — abort and ask the user to wait or pass `--force`.
- Untracked file collision detected on pull — surface to user for manual resolution.
- Host is a protected snapshotter and the requested operation would author or push via `/root/wiki-git` — refuse and use managed live-vault publication + timer promotion instead.

## Forbidden
- Pushing when lint errors exist.
- Auto-resolving body conflicts without user review.
- Force-pushing (`git push --force`).
- Rewriting raw content/frontmatter to resolve conflicts. Preserve-moves must stay under `raw/` (normally `raw/archived/` or `raw/duplicates/`) and require an attended approved structural command; scheduled/headless sync remains report-only.
- Stashing without the `wiki-sync:...` name format (breaks peer detection).
- Force-deleting a peer's lockfile (use `--force` only if peer is confirmed dead).
- Authoring, copying, editing, staging, committing, pulling, resetting, or pushing agent changes in `/root/wiki-git` (or any configured snapshot worktree).
- Running `skillwiki sync push` against a protected snapshot worktree or against a non-Git FUSE live vault.
- Invoking snapshot services/scripts or `git reset --hard` in the snapshot worktree as a recovery shortcut.

## Convergence safeguards (2026-07-11)

### Rebase-state classification
- `stale-clean`: recovery ref at tip + `git rebase --quit` (preserves advanced tip; never abort-reset to orig-head).
- `active` (REBASE_HEAD / UU paths): leave untouched; fail closed.
- Recovery refs live under `refs/vault-sync/recovery/<UTC timestamp>`.

### Materialized-commit proof
Drop a local commit from rebase only when every path is proven present on the target ref (exact blobs; byte-identical added `## ` log sections). Partial/raw/rename mismatches retain or stop.

### Lint-delta fail-closed
- Fingerprints: `<bucket>\0<page>\0<normalized-detail>`
- CLI: `skillwiki sync lint-delta <vault> --base-ref origin/main`
- Block publication only when `new_errors > 0`; inherited full debt remains visible.
- Missing/malformed delta evidence blocks (never silent lint skip).
