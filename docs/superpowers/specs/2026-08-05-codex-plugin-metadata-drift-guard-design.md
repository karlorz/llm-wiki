# Codex Plugin Metadata Drift Guard

Date: 2026-08-05

Status: Approved design; implementation pending written-spec review

Repositories in scope:

- `/Users/karlchow/Desktop/code/llm-wiki`
- `/Users/karlchow/Desktop/code/agent-skills`

## Problem

Codex plugin releases currently validate most versions, paths, and generated
skill mirrors, but duplicated descriptive metadata can become stale without
failing CI. The observed failures are:

- `llm-wiki` documentation says 18 skills even though the canonical plugin
  contains 19, and `wiki-remove` is missing from the hand-maintained table.
- `agent-skills` descriptions advertise `deep-research` as `v2.4.2` while its
  manifest version is `2.4.3`, and advertise `host-backup-restore` as `v3.6.3`
  while its manifest version is `3.6.4`.
- Marketplace inventory checks are one-directional in places, so a stale,
  duplicate, or orphaned catalog entry can survive existing tests.
- Generated mirror checks do not reliably detect every hidden or broken extra
  path.

The original proposal—requiring identical descriptions in every surface—is
too strict. `llm-wiki` intentionally uses different Claude, Codex, and
marketplace descriptions, while Codex-only keywords are also intentionally
platform-specific.

## Decision

Use a layered metadata contract rather than global description equality.

### Shared identity and packaging invariants

For every active plugin in both repositories, CI must verify:

1. Marketplace plugin names are unique.
2. Marketplace source paths are unique and resolve to real plugin directories.
3. Every marketplace plugin has exactly one local Claude manifest.
4. Every discovered local plugin has exactly one marketplace entry.
5. Claude and Codex manifests agree on `name` and `version`.
6. Marketplace and canonical plugin metadata agree on `name` and `version`.
7. Codex manifests expose a valid `skills` path.
8. Generated mirrors contain the same skill set and bytes as their canonical
   sources, with no hidden, broken-symlink, or extra entries.

### Release-marker invariant

Descriptions may remain platform-specific, but any explicit release marker of
the form `v<semver>:` must match that plugin's current manifest version. This
keeps meaningful release headlines honest without forcing identical prose or
keywords across surfaces.

### `llm-wiki` inventory and documentation invariants

The verifier will derive counts and names from canonical directories:

- `skillwiki` count from `packages/skills/*/SKILL.md`.
- `vault-sync` count and names from `packages/vault-sync/skills/*`.

Every manifest or marketplace description that advertises one of those counts
must match the derived value. The documentation table will include
`wiki-remove`; fixed count language will either be corrected and guarded or
replaced with commands that derive the current count.

The Codex marketplace verifier will assert both `skillwiki` and `vault-sync`
entries and their expected local source paths.

### `agent-skills` metadata and configuration invariants

The release-tooling contract will scan every marketplace entry and its Claude
and Codex manifests for the shared identity/version/path rules and release
markers. Codex-only keywords remain allowed. The repository example config
will describe the current nested skill layout and manifest synchronization
behavior; stale hard-coded inventory values will be corrected or removed.

## Implementation shape

### `llm-wiki`

- Extend `scripts/verify-manifests.sh` with bidirectional marketplace checks,
  release-marker checks, vault-sync inventory checks, and robust mirror path
  checks.
- Strengthen `scripts/materialize-plugin-assets.sh --check` so hidden and
  broken extra entries cannot be skipped.
- Update `README.md`, `docs/codex-compatible-reference.md`, and any directly
  affected plugin description text.
- Add focused temporary-fixture regression coverage for stale counts,
  release markers, missing/duplicate marketplace entries, and mirror extras.

Canonical skill files remain the authoring source. Generated mirrors continue
to be produced only by `npm run materialize:plugins` and checked with
`npm run materialize:plugins:check`.

### `agent-skills`

- Add generic metadata and release-marker assertions to
  `scripts/test-dev-loop-release-tooling.sh`.
- Add regression fixtures that mutate a release marker and marketplace
  inventory, proving the checker fails with a useful diagnostic.
- Correct the current `deep-research` and `host-backup-restore` release
  markers.
- Correct `.claude/dev-loop.config.example.md` paths, inventory notes, and
  bump-script description.

## Verification

`llm-wiki`:

```bash
npm run materialize:plugins:check
npm run test:release-lockfile
bash scripts/verify-manifests.sh
npm run -w packages/cli build
```

`agent-skills`:

```bash
bash scripts/test-dev-loop-release-tooling.sh
bash scripts/test-dev-loop-preflight-inventory.sh
bash scripts/test-plugin-release-drift.sh
```

For both repositories, inspect the final diff for accidental generated-file
edits and confirm `git diff --check` is clean. Runtime Codex verification is a
separate post-source step: refresh the configured marketplace, reinstall any
plugin whose version changed, and confirm `codex plugin list` reports the
expected version and enabled state.

## Non-goals

- Do not make every platform description byte-identical.
- Do not remove intentional Codex-only keywords.
- Do not manually edit files under `~/.codex/plugins/cache`.
- Do not publish npm packages, push branches, or create release tags as part of
  this change unless separately requested.
- Do not refactor both repositories into a new metadata-generation system in
  this iteration.

## Risks and mitigations

- **Existing intentional prose differences trigger false failures.** The
  contract compares identity, version, paths, inventory, and explicit release
  markers—not arbitrary descriptions or keywords.
- **A new plugin surface is omitted from the checker.** Inventory checks are
  bidirectional and enumerate marketplace entries rather than checking only a
  fixed index.
- **Generated mirrors drift after a canonical edit.** The materializer check
  remains a required verifier and receives hidden/broken-path coverage.
- **A changed payload remains in an immutable Codex cache.** Version bump and
  runtime reinstall guidance remains explicit; cache contents are never edited
  in place.

## Acceptance criteria

The design is implemented when:

1. The observed stale descriptions and documentation are corrected.
2. A stale release marker fails the relevant repository test.
3. A missing, duplicate, or orphaned marketplace entry fails validation.
4. A hidden or broken extra mirror path fails validation.
5. Both repositories' existing release and preflight suites pass.
6. The documented verification commands describe the current inventory and
   nested plugin layout.
