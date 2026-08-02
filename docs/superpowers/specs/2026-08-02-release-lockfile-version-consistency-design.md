# Release Lockfile Version Consistency Design

**Date:** 2026-08-02  
**Status:** Approved for implementation  
**Scope:** Version bumping and manifest verification only

## Context

The `v0.10.24` release correctly updated all 14 canonical manifests and published
working artifacts, but `package-lock.json` retained `0.10.23` in its root and
versioned workspace metadata. The current bump script does not regenerate the
lockfile, excludes it from stale-version reporting, and the manifest verifier
does not check it. The prior `v0.10.23` release kept these fields synchronized,
so the mismatch is a release-tooling regression rather than an intended
repository convention.

This defect does not change the dependency graph or the behavior of the already
published `v0.10.24` runtime. It weakens reproducibility and allows a release to
pass CI with inconsistent version metadata.

## Goals

- Make every normal version bump regenerate npm lockfile metadata from the
  updated workspace manifests.
- Make the canonical manifest verifier fail when root or versioned workspace
  lockfile metadata differs from the canonical release version.
- Add focused regression coverage for both the synchronized and stale cases.
- Preserve dependency specifications, resolved dependency versions, and
  runtime behavior.
- Use the corrected workflow to publish `v0.10.25`, redeploy the fleet, and
  repeat installed-runtime verification on macOS and sg01.

## Non-goals

- Changing dependency ranges or upgrading dependencies.
- Adding versions to workspaces that npm currently records without a version.
- Changing vault-sync behavior introduced in `v0.10.24`.
- Installing vault-sync on sg02; sg02 remains an agent-memory satellite.
- Requiring checked-in prose release notes when the existing publish workflow
  generates GitHub release notes from commits.

## Design

### Bump workflow

After `scripts/bump-version.sh` updates the canonical manifests, it will run npm
in package-lock-only mode from the repository root:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

Using npm's lockfile generator keeps workspace metadata aligned with npm's own
schema and avoids hard-coding lockfile paths in the mutation logic. The command
must succeed before the script reports a successful bump. It must not install
packages or run lifecycle scripts.

The bump script's final verification will include the same lockfile consistency
check used by the canonical verifier. A failed regeneration or mismatch makes
the bump fail non-zero.

### Verification boundary

`scripts/verify-manifests.sh` remains the canonical release-integrity gate. It
will parse `package-lock.json` structurally and check:

1. top-level `version` equals the canonical CLI version;
2. `packages[""].version` equals the canonical CLI version;
3. every `packages/*` entry that already has a `version` field equals the
   canonical CLI version.

The verifier will report the exact mismatched lockfile key and observed version.
Missing or invalid lockfile structure is a failure. Workspace entries without a
version field are ignored because npm, not this verifier, owns whether those
entries are version-bearing.

The implementation should expose one small reusable command or helper so the
bump script and verifier do not develop different definitions of consistency.
The simplest readable form is preferred during the required simplify review.

### Regression coverage

Focused shell coverage will exercise the lockfile checker against disposable
fixtures:

- a synchronized root and versioned workspace set passes;
- a stale top-level version fails;
- a stale root-package version fails;
- a stale versioned workspace entry fails and names its key;
- a workspace entry without a version remains allowed;
- invalid or missing structural keys fail clearly.

The existing complete manifest verifier and npm install/build/test gates remain
the integration coverage. After the real `0.10.25` bump, a structural inspection
must prove that all version-bearing lock entries are `0.10.25` and that no
dependency resolution changed unexpectedly.

## Error handling and safety

- The bump stops immediately if npm cannot regenerate the lockfile.
- Verification is read-only and exits non-zero on malformed JSON or mismatch.
- The release is not tagged or pushed unless the working tree contains the
  expected version-only lockfile changes and all release gates pass.
- Any dependency-resolution drift beyond version metadata is reviewed as an
  unexpected finding; it is not accepted automatically.
- Fleet upgrades use exact version and commit provenance. sg01 retains its
  protected snapshotter role, macOS retains its leaf role, and sg02 uses only
  its satellite self-update path.

## Release and rollout acceptance criteria

1. Focused lockfile regression coverage passes.
2. `scripts/verify-manifests.sh` passes and covers lockfile consistency.
3. `$simplify:simplify` reviews the hotfix; high-confidence findings are applied.
4. Full build, test, materialization, manifest, pack, and vault-sync gates pass.
5. A clean commit and annotated `v0.10.25` tag point at synchronized manifests
   and lockfile metadata.
6. GitHub CI/publish workflows succeed; GitHub release and npm latest are
   `0.10.25` with the expected commit provenance.
7. macOS and sg01 runtime manifests report `0.10.25`, the release commit, their
   intended roles, and exact source hash matches.
8. The ignored typed-page overlap regression passes against the installed helper
   on both macOS and sg01 using disposable repositories.
9. sg02 user/system CLI and repo report `0.10.25`; its three agent-memory timers
   are enabled and active, its repo/vault are synchronized, and vault-sync remains
   absent.
10. A final independent audit finds no unresolved contradiction. If it does, the
    hotfix/re-release loop repeats at the next patch version.

## Alternatives rejected

- **Directly edit selected lockfile fields:** network-independent but duplicates
  npm's schema and can silently miss future workspace changes.
- **Patch only the `v0.10.25` lockfile:** repairs one release while leaving the
  bump and CI gap intact.

