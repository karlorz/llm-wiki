# ADR 0002: Workspace Control-Plane Dead-PID Reclaim

## Status

Accepted

## Date

2026-10-27

## Context

The workspace control plane (`packages/mcp-server/src/workspace-store.ts`) is single-writer: one daemon process owns `workspaces.json` in the configured state directory, guarded by `workspaces.lock`. The lock records the owner as `{ pid, host, id }`, where `id` is a fresh `randomUUID()` per store instance.

The original constructor refused to start whenever `workspaces.lock` existed. That was deliberate: reclaiming by inspecting and then renaming could let two simultaneous reclaimers each move a lock, and a racer could rename a replacement owner's live lock, leaving two daemons writing the same control plane.

That fail-closed rule assumed attended recovery. On sg01 the daemon runs under systemd with `RestartSec=5`, so an unclean exit leaves a lock behind and every restart throws `CONTROL_PLANE_LOCKED` — an indefinite crash-loop with no writer, and the loop itself prevents the operator from being paged by a stable failure.

## Decision

1. **Dead same-host PID is the only reclaimable state.**
   - The constructor first attempts `openSync(lock, "wx", 0o600)` and writes the owner record. `EEXIST` starts reclaim; no other create error is swallowed.
   - The existing record must parse strictly: `pid` a positive safe integer, `host` a non-empty string, `id` a UUID in the exact shape `randomUUID()` emits. Malformed, unreadable, or path-like ids fail closed with the lock bytes untouched.
   - `host` must equal `hostname()`. A foreign host fails closed.
   - Liveness is `process.kill(pid, 0)`: success and `EPERM` both mean alive and fail closed; only `ESRCH` permits reclaim. Any other error fails closed rather than being read as death. Reclaim is never decided by lock age.

2. **Rename, verify, restore.**
   - `recovery/` is created (`0o700`), and the live lock is renamed to `workspaces.lock.stale-<stamp>-<fresh UUID>.json`. The suffix is a new UUID, never the stale owner id, and an existing destination is never overwritten.
   - The moved file is re-read. If its `id` differs from the inspected stale id, another reclaimer has already replaced the live path and this process moved that owner's lock: it is renamed back and the constructor fails closed. A failed restore still fails closed.
   - Only after the moved record matches is the replacement lock created. `ENOENT` on the rename means another reclaimer moved the file first; the single retry is a create attempt whose `EEXIST` fails closed.

3. **Ownership is unchanged on release.** `close()` still compares the recorded `id` against this instance's `lockId` before unlinking, so a store that lost ownership throws `LOCK_OWNER_CHANGED`.

4. **Control state is never reset.** Reclaim only touches the lock; `workspaces.json` bytes are preserved for operation resumption.

## Consequences

### Positive
- An unclean daemon exit no longer crash-loops the only writer: the next start reclaims a provably dead same-host lock and resumes persisted operation state.
- The verify-restore step closes the race Codex flagged. A reclaimer that loses the race moves a live replacement lock, detects the id mismatch, restores it, and reports `CONTROL_PLANE_LOCKED`, so two daemons never share the control plane.
- Every ambiguous case — live PID, `EPERM`, foreign host, unreadable or non-UUID record, unexpected `process.kill` error — remains fail-closed with the lock bytes intact.

### Negative / Trade-offs
- Recovery of a foreign-host or malformed lock is still attended: an operator must stop competing processes and repair the lock offline. This is the deliberate cost of not treating unknown state as dead.
- A reclaimed lock is quarantined under `recovery/` rather than deleted, so stale-lock evidence accumulates until an operator prunes it.
- Correctness depends on PID liveness being meaningful on the lock's host. A recycled PID from an unrelated process reports alive and fails closed instead of reclaiming — safe, but it turns an automatic recovery into an attended one.
- The optional third constructor argument (`afterStaleInspect`) exists only so tests can interleave a second reclaimer between inspection and rename. Production call sites pass `(directory)` or `(directory, now)` and never observe it.
