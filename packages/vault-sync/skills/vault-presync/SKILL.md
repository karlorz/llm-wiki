---
name: vault-presync
description: Pre-sync lint gate, collision dedup, and rebase for ~/wiki vault. Removes untracked local files that are byte-identical to remote-tracked files, detects rebase conflicts, then git pull --rebase. Run before wiki-sync or git push.
argument-hint: "[--dry-run|--execute|--force]"
---

# vault-presync

Pre-sync helper that handles the full sync pipeline for the ~/wiki vault: lint gate, untracked-file collision removal, conflict detection, and rebase-based merge.

## When to use

- Before `git push` from the ~/wiki vault (after editing sessions)
- When `git pull` fails with "The following untracked working tree files would be overwritten by merge"
- When `git merge --ff-only` fails due to divergent histories (local + remote both have commits)
- After a Claude Code session that modified vault files
- Periodically to keep the local vault in sync with sg01 30-minute snapshots

## What it does

1. **Fetches** remote state, reports AHEAD/BEHIND/DIRTY counts
2. **Lint gate** — runs `skillwiki lint`; blocks on errors (unless `--force`)
3. **Finds collisions** — untracked local files that `origin/main` already tracks
4. **Removes collisions** — deletes byte-identical local copies (safe dedup); preserves local edits that differ
5. **Detects rebase conflicts** — when local and remote both touch the same files, warns before rebase
6. **git pull --rebase** — replays local commits on top of remote (handles divergent histories, unlike ff-only)
7. **Stash protection** — stashes dirty tracked files before rebase, pops after, with conflict guidance
8. **Reports** remaining untracked files (genuine new work)

## Execution

### From terminal (CLI)

```bash
# After vault-sync-install, the helper is installed as a terminal command.
~/bin/wiki-sync.sh              # dry-run
~/bin/wiki-sync.sh --execute    # dedup + rebase
~/bin/wiki-sync.sh --force      # skip lint gate
```

`vault-sync-install` deploys the stable helper to the platform vault-sync bin
directory and creates/repairs `~/bin/wiki-sync.sh` when it is safe to do so.
It will not clobber a real non-symlink user file at that path.

For repo/plugin development before install, run the skill-local helper directly:
```bash
bash packages/vault-sync/skills/vault-presync/wiki-sync.sh
```

Codex plugin install only installs plugin assets; it does not mutate host state,
`~/bin`, launchd, or systemd. Run `vault-sync-install` to install or repair the
terminal helper on a host.

### From Claude Code session

Invoke via the Skill tool — Claude runs the script inline:
```
/vault-presync --execute
```

Or run directly via Bash within a Claude session:
```bash
bash packages/vault-sync/skills/vault-presync/wiki-sync.sh --execute
```

The script auto-detects the vault root from `skillwiki path` → git root → script-relative path → `$HOME/wiki` fallback. No hardcoded paths.

## Rebase conflict resolution

When both local and remote touch the same files, `git rebase` pauses with conflicts. The script detects this pre-rebase (step 5) and warns which files overlap. If conflicts occur during rebase:

1. **Find conflicted files:** `git diff --name-only --diff-filter=U`
2. **Frontmatter `updated:` conflicts** — always keep the newer timestamp
3. **Body conflicts** — prefer the version with more content (the other side may be a truncated rclone race victim)
4. **Mark resolved:** `git add <file>`
5. **Continue:** `git rebase --continue`
6. **Restore stash:** `git stash pop` (if the script stashed before rebase)

To abort a broken rebase: `git rebase --abort`

## Lint gate

The script runs `skillwiki lint` before syncing. Errors block the sync (use `--force` to override). Warnings are logged but do not block. This prevents pushing malformed frontmatter (like the 2026-05-22 YAML bug where orphaned `- tags` lines broke 8 pages).

## Multi-writer sync topology (current, 2026-05-22)

The ~/wiki vault has three concurrent writers:

| Writer | Mechanism | Frequency |
|--------|-----------|-----------|
| **sg01** (hermes-agent) | rclone mount → edit → git snapshot → rebase → push to GitHub | Every 30 min + on-demand |
| **macOS Claude Code** | Direct file edits (CLI writes, skillwiki commands) → git commit → push to GitHub | Per-session |
| **Obsidian** | Opens vault read-only via rclone FUSE; Remotely Save plugin for S3 download | Ad-hoc |

**Key insight:** Both sg01 and macOS Claude Code can commit and push to GitHub independently. This creates divergent histories — macOS may have 1-3 local commits while sg01 pushes 15+ snapshot commits. The script uses `git pull --rebase` (not `git merge --ff-only`) to replay local commits on top of remote, which handles this naturally.

**Collision pattern:** sg01 pushes files to GitHub that also exist as untracked locally (from rclone bisync, drift-apply, or concurrent Claude sessions). The script removes byte-identical duplicates and preserves files with local edits.

**2026-05-22 incident note:** A rclone VFS write-back race on sg01 truncated 30+ wiki pages. The presync lint gate would have caught the resulting malformed YAML (orphaned list items below `tags:` lines) before they reached GitHub. The skillwiki CLI v0.5.4 `safeWritePage` guard now prevents recurrence at the write layer.

## After wiki-sync

Once complete, the vault is ready for:
- `git push` (local commits replay cleanly on top of remote)
- `git pull` (no collision errors)
- New Claude Code sessions (working tree is consistent with remote)
- `skillwiki lint` (errors caught before push, not after)
