# FUSE read-mirror for `status` and `session-brief`

## Date
2026-08-10

## Context

On sg01 (the protected snapshotter), the live vault at `/root/wiki` is an
rclone FUSE mount, not a Git repository. When an agent runs
`skillwiki status` or `skillwiki session-brief`, both commands call
`scanVault(input.vault)` directly on the FUSE path. `scanVault` recursively
walks the entire vault tree via `readdir` + `statSync` on every `.md` file.
On a cold rclone VFS cache this takes minutes and appears to hang.

The agent eventually killed the hung `skillwiki status` after 5.5 seconds and
reasoned from first principles that `--no-commit` was correct. This is
fragile - the next agent may not figure it out.

## Root cause

`packages/cli/src/utils/vault.ts` already has `resolveReadOnlyVaultRoot()`
which detects `fuse.rclone` mounts via `/proc/mounts` and redirects read
operations to the sibling git worktree (`${root}-git`, i.e. `/root/wiki-git`
on sg01). It also respects two env overrides:

- `SKILLWIKI_VAULT_READ_MIRROR` - explicit mirror path
- `SKILLWIKI_DISABLE_VAULT_READ_MIRROR` - disable mirroring

`doctor` (line 1992 via `doctorReadOnlyScanRoot`) and `lint` (line 247) already
call `resolveReadOnlyVaultRoot()` before scanning. `status.ts` and
`session-brief.ts` do **not**.

## Solution

Apply `resolveReadOnlyVaultRoot()` at the top of `runStatus()` in `status.ts`
and `runSessionBrief()` in `session-brief.ts`, before calling `scanVault()`.

When the vault is a FUSE mount with a mirror present, the scan reads from the
git worktree (local disk, fast). When no FUSE mount or no mirror exists,
behavior is unchanged.

### `status` output changes

`StatusOutput` gains a `read_source` field:

```typescript
read_source: "live" | "mirror";
```

When mirrored, `humanHint` gains a line:

```
read source: mirror (/root/wiki-git) - page counts may lag up to 30m
```

When the vault is a FUSE mount but **no mirror exists**, `humanHint` gains:

```
FUSE vault with no read mirror - status scan may be slow
```

This replaces silent hanging with a clear signal.

### `session-brief` changes

`runSessionBrief()` applies the same `resolveReadOnlyVaultRoot()` call before
`scanVault()`. No output change needed - session-brief is an internal command
whose output is consumed by the agent, not displayed to users.

## Affected files

| File | Change |
|---|---|
| `packages/cli/src/commands/status.ts` | Import `resolveReadOnlyVaultRoot`. Call it before `scanVault()`. Add `read_source` to `StatusOutput`. Update `humanHint`. |
| `packages/cli/src/commands/session-brief.ts` | Import `resolveReadOnlyVaultRoot`. Call it before `scanVault()`. No output change. |

## What does NOT change

- `scanVault` in `vault.ts` - unchanged; no shared-utility blast radius
- `work-complete` flow - already auto-skips commit on FUSE (no `.git`)
- `sync status` - already returns `not_a_repo` on FUSE (correct behavior)
- `doctor` and `lint` - already use the mirror
- All env-var overrides (`SKILLWIKI_VAULT_READ_MIRROR`,
  `SKILLWIKI_DISABLE_VAULT_READ_MIRROR`) - handled inside
  `resolveReadOnlyVaultRoot()`, continue to work

## Testing

### Existing tests

`status.test.ts` and `session-brief` tests run against local temp dirs (not
FUSE). `resolveReadOnlyVaultRoot()` returns the same path (no mirror detected)
- behavior unchanged.

### New test

Add a test case in `status.test.ts` that sets `SKILLWIKI_VAULT_READ_MIRROR`
to a sibling dir with `SCHEMA.md` and verifies:

1. `read_source === "mirror"`
2. `humanHint` contains the mirror path
3. Page counts are read from the mirror, not the original vault path

### Manual verification

After implementation, run `skillwiki status` on sg01 and confirm it completes
in seconds instead of hanging.

## Trade-offs

The mirror (`/root/wiki-git`) may lag behind the FUSE mount by up to 30 minutes
(snapshot timer cadence at `*:02` and `*:32`). Page counts in `status` output
may be slightly stale. This is acceptable for a status check - the agent needs
a quick snapshot, not byte-freshness. The `humanHint` explicitly surfaces this
lag so the agent can interpret the counts correctly.

## Non-goals

- Adding a FUSE-aware fast-path to `status` that returns timer/log state
  instead of page counts (Approach C from brainstorming - possible future
  enhancement)
- Changing `scanVault` itself (Approach B - too high blast radius)
- Modifying `work-complete` output messages (separate concern)
