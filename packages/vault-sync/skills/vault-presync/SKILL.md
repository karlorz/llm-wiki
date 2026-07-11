---
name: vault-presync
description: Pre-sync lint-delta gate, collision dedup, and rebase for ~/wiki vault. Removes untracked local files that are byte-identical to remote-tracked files, detects rebase conflicts, then delegates pull to wiki-pull-with-auto-resolve. Run before wiki-sync or git push.
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
2. **Lint-delta gate** — runs `skillwiki sync lint-delta --base-ref origin/main`; blocks only when `new_errors > 0` (unless `--force`). Inherited debt is visible but non-blocking. Malformed/missing delta evidence fails closed.
3. **Finds collisions** — untracked local files that `origin/main` already tracks
4. **Removes collisions** — deletes byte-identical local copies (safe dedup); preserves local edits that differ
5. **Detects rebase conflicts** — when local and remote both touch the same files, warns before rebase
6. **Canonical pull** — delegates to `wiki-pull-with-auto-resolve.sh` (shared with unattended fetch). That helper owns an operation journal, freezes the remote tip as an exact OID, classifies rebase state, drops only fully materialized local commits, and auto-resolves archive/log conflicts.
7. **Owned stash protection** — dirty tracked/untracked files are stashed with a helper-owned message `vault-sync op=<op_id> …` and recorded by **exact stash OID** in the journal (not legacy peer-name stash guessing). Apply/drop use that OID only.
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

## Operation journal + frozen tip + one owned retry

`wiki-pull-with-auto-resolve.sh` records every convergence attempt under the vault git path (helper-owned journal files + recovery refs). Logs include `op=<op_id>` lines (for example `STASH oid=… op=…`, `RETRY … op=…`, `OK pull completed op=…`). There is **no** legacy `wiki-pull auto-stash` path.

Convergence properties:

| Property | Behavior |
|----------|----------|
| Frozen tip | After fetch, pin `TARGET_OID=$(git rev-parse origin/main)` (exact OID, not a moving symbolic tip alone) |
| Owned stash | Stash message embeds `op=<id>`; journal stores `owned_stash_oid`; restore/drop only that OID |
| One stale-target retry | On non-archive manual conflict, if remote advanced and conflict identity is still owned/unmutated, **one** retry: abort, re-freeze tip, rebase again |
| Handoff | Second conflict, human mutation, or exhausted retry → `handoff=1` / review-required; later runs refuse to reclaim handoff rebases |
| No force-push | Pull helper never publishes; no `--force` / `--force-with-lease` push flags |

Journal lifecycle (high level): begin → inventory → optional stash → rebasing → (optional retrying) → complete **or** review-required handoff.

After install/rollout, confirm pull logs show `op=` journal lines and no legacy auto-stash wording before touching `$(platform_share_dir)/live-verify.ok` (see vault-sync-install attended checklist).

## Rebase-state classification (canonical pull helper)

Before pull, `wiki-pull-with-auto-resolve.sh` classifies leftover sequencer state:

| State | Meaning | Action |
|-------|---------|--------|
| `none` | No rebase directory | Proceed |
| `stale-clean` | Sequencer dir exists, no unmerged paths, live tip advanced past `orig-head` | Create `refs/vault-sync/recovery/<UTC>` at current HEAD, then `git rebase --quit` (never `--abort`) |
| `active` | `REBASE_HEAD` / unmerged paths / in-progress context | Fail closed — leave state untouched (handoff journals are never auto-cleaned) |

**Never** raw-`rm` sequencer directories or `git rebase --abort` for unattended cleanup: abort resets the tip to `orig-head` and can discard newer authored work (2026-07-11 incident class).

## Materialized-commit proof

Local commits fully present on the remote tip may be dropped from the rebase todo only when every changed path is proven:

- Ordinary add/modify: target blob equals commit blob
- Delete: path absent on target
- `log.md` / `*/log.md`: every added `## ` section body occurs byte-for-byte in the target log

Any partial match, rename, binary mismatch, raw-path difference, or unprovable change retains the commit or stops for review — never silent drop.

## Lint-delta fail-closed

Publication and presync execute parse `skillwiki sync lint-delta` JSON:

- Report `full_errors` / `base_errors` / `new_errors` / `resolved_errors`
- Block only when `new_errors > 0`
- If the CLI is missing or JSON is malformed → fail closed (do not skip lint)

## Rebase conflict resolution


When both local and remote touch the same files, `git rebase` pauses with conflicts. The script detects this pre-rebase (step 5) and warns which files overlap. If conflicts occur during rebase:

1. **Find conflicted files:** `git diff --name-only --diff-filter=U`
2. **Frontmatter `updated:` conflicts** — always keep the newer timestamp
3. **Body conflicts** — prefer the version with more content (the other side may be a truncated rclone race victim)
4. **Mark resolved:** `git add <file>`
5. **Continue:** `git rebase --continue`
6. **Restore owned stash:** only the journaled stash OID is applied/dropped (if the pull helper stashed before rebase)

To abort a broken rebase when you intend to discard the in-progress replay: `git rebase --abort` (attended only — unattended cleanup never uses abort for stale-clean state).

## Lint gate

The script runs `skillwiki sync lint-delta` before syncing. Only **new** errors block the sync (use `--force` to override). Inherited full-error debt is warned but non-blocking. Malformed delta evidence fails closed. This prevents pushing malformed frontmatter (like the 2026-05-22 YAML bug where orphaned `- tags` lines broke 8 pages).

## Conflict-marker guard

If sync reports `conflict_markers`, inspect the reported file and remove the
literal Git marker block after preserving the intended content. Then run:

```bash
skillwiki lint --only conflict_markers
~/bin/wiki-sync.sh --execute
```

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
