# Documentation Index

## Project Documentation

- [Project overview](README.md)
- [Codex plugin reference](docs/codex-compatible-reference.md)

## Package Documentation

- [Skill package](packages/skills/README.md)
- [Agent memory trends](packages/agent-memory-trends/README.md)
- [SkillWiki maintenance](packages/skillwiki-maintenance/README.md)
- [Vault-sync offline-host runbook](packages/vault-sync/docs/offline-host-runbook.md)
- [Vault-sync health invariants](packages/vault-sync/docs/health-invariants.md)
- [Managed-write lock reclaim runbook](packages/vault-sync/docs/managed-write-lock-reclaim-runbook.md)
- [Credential rotation & env sanitization runbook](packages/vault-sync/docs/credential-rotation-runbook.md)
- [Remote E2E host profiles](scripts/hosts/README.md)

## Wiki Vault — `{WIKI_PATH}`

- [Vault schema]({WIKI_PATH}/SCHEMA.md)
- [Vault index]({WIKI_PATH}/index.md)
- [llm-wiki project index]({WIKI_PATH}/projects/llm-wiki/README.md)

## Canonical Specification

- [SkillWiki skill design]({WIKI_PATH}/projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md)

## Architecture and Operations

- [Vault-sync topology]({WIKI_PATH}/projects/llm-wiki/architecture/2026-05-23-vault-sync-topology.md)
- [Vault-sync fleet manifest]({WIKI_PATH}/projects/llm-wiki/architecture/2026-05-25-vault-sync-fleet-manifest.md)
- [Vault Git authority]({WIKI_PATH}/projects/llm-wiki/architecture/2026-06-08-vault-sync-git-authority.md)
- [Vault delete and archive protocol]({WIKI_PATH}/projects/llm-wiki/architecture/2026-06-10-vault-sync-delete-archive-protocol.md)
- [Agent memory architecture]({WIKI_PATH}/projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md)
- [Cross-harness SkillWiki context injection]({WIKI_PATH}/projects/llm-wiki/architecture/decisions/2026-08-04-skillwiki-context-injection-3.md) - activation file, ADRs 1-8, glossary, `install:activation`

## Release hygiene (v0.10.39 lessons)

- **Date-sensitive tests must use relative dates.** Absolute fixture dates
  (e.g. `2026-08-02-pending.md` in `health.test.ts`) silently go stale when
  the 7-day freshness window passes and fail release CI. Compute fixture
  dates from `Date.now()` (e.g. yesterday) so suites stay green forever.
- **Run the full CLI suite locally before `release.sh --watch`.** A test
  failure at the publish workflow burns the tag (tags are immutable per
  health invariant H7) and forces a new tag + re-release. Verify
  `npx vitest run packages/cli/test/` (and maintenance/`test/`) locally
  first.
- **Health-summary exit policy:** on `unattended-daily`, parsed blocking
  health findings are advisory (`warn`) so pre-existing content debt does not
  overturn a successful writer/push; command/parse failures stay fatal.
  `attended-full` remains strict. See `packages/skillwiki-maintenance/README.md`.
