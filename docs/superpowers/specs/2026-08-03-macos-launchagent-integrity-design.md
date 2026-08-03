# macOS LaunchAgent Integrity Design

**Date:** 2026-08-03  
**Status:** Approved for implementation  
**Scope:** macOS leaf `vault-sync` LaunchAgent integrity only

## Context

During the `v0.10.26` macOS leaf redeploy, the two on-disk LaunchAgent files
were malformed JSON-like content instead of valid plist XML. Existing launchd
registrations were still loaded in memory, so sync continued to run, but the
deployment would not have been reliable after a reload or reboot.

The current installer did not generate the malformed files: it renders
canonical XML templates and validates a staged candidate before bootstrap. The
status surface nevertheless reported a healthy deployment because its read-only
macOS check only required the two plist paths to exist. Its runtime-manifest
proof also ignored the recorded `LaunchAgents/...` file hashes. Finally, a
failed bootstrap could restore an arbitrary prior plist without confirming that
the rollback artifact was itself valid.

The observed dirty vault checkout, inherited lint debt, stale Claude plugin,
and prior fail-closed auto-pull handoff are separate operational or content
concerns. They are deliberately outside this change.

## Goals

- Make malformed, incomplete, or wrongly labelled macOS vault-sync plists
  visible as deployment errors in `vault-sync-status`.
- Require both valid on-disk plist definitions and live scheduler registration
  before the macOS jobs-enabled check can pass.
- Include deployed LaunchAgent files in runtime-manifest drift verification.
- Never restore a known-invalid plist during installer rollback.
- Preserve valid rollback behavior, existing Linux/systemd behavior, and
  vault push/fetch policy.
- Ship the correction as `v0.10.27` after focused and full release validation.

## Non-goals

- Repairing the vault's existing broken wikilinks or taxonomy debt.
- Making S3 push fail because `log.md` is dirty or the local vault is ahead.
- Updating the independently installed Claude plugin cache.
- Changing auto-pull conflict resolution or its source-checkout `npx` fallback.
- Replacing launchd with another scheduler or changing timer intervals.

## Design

### Shared LaunchAgent validation

Add a reusable macOS plist validator in the vault-sync platform library. Given
an expected label and plist path, it checks that the path is a regular file,
`plutil -lint` accepts it when available, the expected `Label` is present, and
`ProgramArguments[0]` is populated. The helper returns a concise reason for
callers to report; it does not mutate the file.

The installer will call this helper for staged candidates and retain its
existing successful-install behavior. The status checker will call the same
helper for the push and fetch definitions, avoiding two incompatible ideas of
what constitutes a valid deployed plist.

### Status and runtime semantics

On macOS, both read-only and live status modes validate the two installed
plists before reporting scheduler health:

- missing plist files remain warnings, preserving the existing incomplete-setup
  classification;
- malformed structure, a wrong label, or a missing command argument is an
  error because the deployment cannot safely survive launchd reload;
- live `launchctl print` success alone is insufficient: it must be paired with
  valid deployed files;
- Linux/systemd status behavior is unchanged.

The installer already records hashes for `LaunchAgents/...` in
`runtime-manifest.json`. Status will compare those entries to the actual
deployed plist files. Valid-but-changed plist bytes are reported as runtime
drift; syntactically invalid files are already surfaced as deployment errors.
Script entries continue to compare against package source as today.

### Rollback safety

Before replacing a pre-existing plist, the installer records whether the prior
artifact passed the same validation. It still retains a byte-for-byte rollback
copy for diagnostics.

If bootstrap of the new, validated candidate fails, the installer restores the
prior plist only when it was valid. If the previous artifact was invalid, the
installer leaves the validated candidate on disk, reports that no valid rollback
was available, and exits non-zero. This avoids silently reinstalling a corrupt
definition while preserving enough evidence for an operator to diagnose the
bootstrap failure.

### Regression coverage

Focused shell tests will cover:

- read-only and live status with empty, JSON-like/malformed, wrong-label, and
  missing-`ProgramArguments` plist fixtures;
- a stale live launchd label paired with an invalid on-disk plist;
- a valid deployed plist whose bytes no longer match its runtime manifest;
- successful rollback to a valid original plist;
- refusal to restore an invalid original plist after repeated bootstrap failure.

The normal vault-sync suite, manifest verification, build/typecheck, full test
suite, local E2E harness, package tarball inspection, and release workflow
remain the release gates.

## Error handling and safety

- Validation is read-only in status mode and never reloads jobs.
- A malformed plist is an explicit error, not an optimistic status pass.
- A failed install remains non-zero; it does not claim a successful runtime
  manifest or release deployment.
- Rollback artifacts remain preserved in the existing cache location.
- The installer never touches vault content as part of this change.

## Acceptance criteria

1. Empty or malformed macOS plist files no longer yield a passing
   `vault_sync_jobs_enabled` status.
2. A loaded launchd label cannot mask invalid on-disk configuration.
3. Runtime-manifest verification detects deployed plist byte drift.
4. Failed bootstrap never restores an invalid previous plist.
5. Existing valid rollback and Linux/systemd tests continue to pass.
6. Full release verification passes, `v0.10.27` is tagged and published, and
   the macOS runtime is redeployed with matching version and commit provenance.

## Alternatives rejected

- **File-presence-only status:** too weak; it caused the false healthy report.
- **Rendered-template byte comparison at every status run:** brittle because
  rendering includes host-specific paths and environment values. Manifest
  comparison records the exact artifact actually installed.
- **Fixing vault content or Claude state in this patch:** expands the change
  beyond the deployment defect and risks mutating user-managed data.
