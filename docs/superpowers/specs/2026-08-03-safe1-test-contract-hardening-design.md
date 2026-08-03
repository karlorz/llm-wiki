# SAFE-1 Test Determinism and Contract Hardening Design

**Date:** 2026-08-03
**Status:** Approved for implementation
**Scope:** Deterministic managed-write tests and migration of legacy lock expectations to the approved SAFE-1 ordering

## Context

SAFE-1 is implemented in commit `d4aa7b3` in the isolated `llm-wiki`
worktree. The production gate is centralized in
`runManagedWriteTransaction`: it acquires the managed-write lock, completes
preflight/convergence, performs one structured peer check, and invokes
`mutate` only when the peer result is valid and nonblocking.

The focused SAFE-1 and sync tests, typecheck, and build pass. The complete
monorepo test run is not deterministic on the current macOS host because two
host-global `wiki-push.sh` processes are visible to the real process snapshot.
Consequently, command tests that create temporary fixture vaults fail before
mutation with the intended `live-writer-overlap` result.

A small number of existing tests also assert the pre-SAFE-1 behavior in which a
command-owned publication lock is reached inside `mutate`, producing
`SYNC_LOCK_HELD`, or ingest first creates a raw-only capture before typed
publication fails. The approved SAFE-1 boundary intentionally moves the peer
check before `mutate`, so those expectations must be updated rather than
weakening the gate.

## Goals

- Make the complete monorepo test suite deterministic without killing,
  pausing, or modifying host-global writer processes.
- Preserve the real `runSyncPeers` implementation for lock files, stash audit,
  structured output, and dedicated sync/peer-gate tests.
- Suppress only live process discovery in affected fixture-based command tests.
- Update legacy foreign-lock and raw-only-ingest expectations to the approved
  SAFE-1 pre-mutation contract.
- Leave production SAFE-1 behavior and its public default path unchanged.
- Confirm `npm test`, typecheck, build, and diff checks pass before `/goal`.

## Non-goals

- Changing `runManagedWritePeerGate`, its failure mapping, or its ordering.
- Adding a production environment bypass for peer checks.
- Adding new command-level dependency plumbing solely for test control.
- Killing, pausing, or reconfiguring `wiki-push`, `rclone`, or `vault-sync`.
- Changing sync-peer classification, stash policy, convergence, managed-lock,
  fleet, journal, or dirty-volume policy.
- Changing S3, vault, plugin, stash, remote, PR, release, or SkillWiki state.
- Addressing optional review-documentation suggestions in this cycle.

## Design

### Test-local peer adapter

Four affected Vitest files will replace only the imported `runSyncPeers`
function with a test-local adapter:

- `packages/cli/test/commands/page-publish.test.ts`
- `packages/cli/test/commands/ingest.test.ts`
- `packages/cli/test/commands/project-page-publish.test.ts`
- `packages/cli/test/commands/index-rebuild.test.ts`

The adapter will preserve every export from `src/commands/sync.ts` and delegate
to the real implementation with an empty process snapshot:

```ts
runSyncPeers({ ...input, processSnapshot: "" })
```

The mock is scoped to each affected test file. It is not installed globally,
and it is not used by `sync.test.ts` or
`managed-write-preflight.test.ts`. Therefore, the test suite continues to
exercise real managed-writer classification and the injected gate contract in
the dedicated unit tests, while command tests no longer inherit unrelated
host process state.

This uses the existing `processSnapshot` test seam rather than introducing an
environment variable, a fake `ps` executable, or a new production bypass. Real
fixture lock files and stash audits remain visible to `runSyncPeers`, so a test
that creates a foreign `.skillwiki/sync.lock` still exercises the actual peer
lock path.

### SAFE-1 contract updates

Tests that deliberately hold a foreign sync/publication lock will assert the
centralized peer gate instead of the old nested-lock behavior.

For page publish:

- Expect exit code `PREFLIGHT_FAILED`.
- Expect error `PREFLIGHT_FAILED`.
- Expect stable detail reason `peer-lock`.
- Verify the pre-existing lock remains unchanged.
- Verify no publication mutation or replacement lock is created.

For ingest:

- Rename the raw-only-lock test to describe pre-mutation peer rejection.
- Expect `PREFLIGHT_FAILED` with reason `peer-lock`.
- Verify no raw capture is created.
- Verify no typed page is created.
- Verify the foreign lock remains unchanged.

This is required by the approved invariant: a blocking peer result prevents
`mutate` from running, and ingest's raw capture is inside that callback. The
old raw-only behavior cannot remain a side effect of a blocked pre-mutation
transaction.

Project-page publish and index-rebuild write tests will use the process-free
adapter for ordinary fixture writes. Their production command code remains
unchanged.

### Test ownership

- `packages/cli/test/commands/sync.test.ts` owns process-snapshot parsing,
  managed-writer kinds, lock enumeration, stash audit, and `blocking` output.
- `packages/cli/test/utils/managed-write-preflight.test.ts` owns gate ordering,
  lock-held timing, all transaction modes, injected peer outcomes, stable
  reasons, malformed/non-OK/throwing results, and privacy redaction.
- Command tests own publication, ingest, project-page, and index-rebuild
  behavior after a deterministic nonblocking peer observation.
- Foreign-lock command tests own the end-to-end assertion that the centralized
  gate preempts command-owned nested lock behavior.

## Error handling and safety

The test adapter must not alter the real result shape or error mapping. If a
fixture lock is present, the real `runSyncPeers` implementation must still
return it and the managed-write gate must still fail closed. If the adapter
itself is malformed, focused gate tests remain responsible for catching that
class of failure through their direct injected-checker cases.

No test helper may expose command lines, paths, PIDs, stash bodies, or other
host-local process details in assertions or persisted artifacts. The adapter
only supplies an empty process snapshot and does not persist it.

## Verification plan

Run the affected command suites first:

```bash
npm run -w skillwiki test -- \
  test/commands/page-publish.test.ts \
  test/commands/ingest.test.ts \
  test/commands/project-page-publish.test.ts \
  test/commands/index-rebuild.test.ts
```

Then run the focused SAFE-1 and sync suites:

```bash
npm run -w skillwiki test -- \
  test/utils/managed-write-preflight.test.ts \
  test/commands/sync.test.ts
```

Run the complete project suite:

```bash
npm test
```

Run static validation:

```bash
npm run -w skillwiki typecheck
npm run -w skillwiki build
git diff --check origin/main...HEAD
```

The complete suite must exit successfully without terminating or pausing the
active host writers. Any remaining failure must be investigated before the
implementation is considered ready for `/goal`.

## Acceptance criteria

1. Only the four affected command test files receive the process-snapshot
   adapter; production source files remain behaviorally unchanged.
2. Fixture lock files are still detected by the real peer checker.
3. Page publish foreign-lock tests assert `PREFLIGHT_FAILED` / `peer-lock` and
   no mutation.
4. Ingest foreign-lock tests assert `PREFLIGHT_FAILED` / `peer-lock` and no
   raw-only side effect.
5. SAFE-1 focused tests remain green and continue covering real process
   classification through their existing dedicated suites.
6. The complete `npm test` suite passes on the current host.
7. Typecheck, build, and `git diff --check` pass.
8. No source, vault, S3, stash, plugin, remote, PR, or release action occurs
   outside the intended test changes and design document.
9. The implementation remains on the isolated feature branch/worktree until
   a separate integration decision.

## Alternatives rejected

### Thread a peer checker through every command dependency bundle

This would provide an explicit command-level seam, but it would expand the
production-facing optional API across page publish, project-page publish,
ingest, and index rebuild for a test-only concern. The existing
`processSnapshot` seam already supports deterministic peer observation without
that source churn.

### Fake `ps` or add a runtime environment bypass

A fake executable or environment bypass has broad process-wide effects and can
change unrelated host-health tests. It also risks creating an operational
escape hatch around the safety gate. The test-local adapter is narrower and
preserves production behavior.
