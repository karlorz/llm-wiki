---
name: Dev loop project config
description: Project-specific values for the dev-loop skill. Activated in Phase 3 cutover.
type: project
status: active
phase: 3
---

# Dev Loop — llm-wiki

> **Status**: ACTIVE. Phase 3 cutover complete.

## Identity

```yaml
slug: llm-wiki
vault: ~/wiki
release_branch: dev
knowledge_layer: skillwiki

# Knowledge backend registry — explicit declaration for BACKEND_CAPS resolution
# When absent, dev-loop derives BACKEND_CAPS from knowledge_layer + vault (backward-compatible)
knowledge_backends:
  skillwiki:
    vault: ~/wiki
    cli_entry: npx tsx packages/cli/src/cli.ts  # local dev override
  none:
    work_dir: .claude/dev-loop-work/
```

## Code layout

```yaml
cli_src: packages/cli/src/commands/
cli_test: packages/cli/test/commands/
skills_glob: packages/skills/*/SKILL.md
cli_entry_override: npx tsx packages/cli/src/cli.ts
```

## E2E

```yaml
e2e_scripts:
  - scripts/e2e-local.sh
  - scripts/e2e-remote.sh
  - scripts/e2e-plugin.sh
```

## Release

```yaml
bump_script: ./scripts/bump-version.sh
publish_via: ci-tag-trigger
manifests_count: 6
remote_hosts: [sg01]
```

## Notes

```yaml
notes:
  canonical_spec: projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md  # relative to vault
  hermes_compat: |
    Vault at ~/wiki is wire-compatible with Hermes llm-wiki v2.1.0.
    ~/.skillwiki/.env is primary config (WIKI_PATH, WIKI_LANG).
    ~/.hermes/.env is read-only fallback for WIKI_PATH.
    Vault structure (raw/, entities/, concepts/, etc.) is identical.
    SCHEMA.md, index.md, log.md conventions are shared.
  push_workflow: |
    Sequence:
    1. Bump all 6 manifests in lock-step via bump_script.
    2. Commit and push to dev branch — this push IS the plugin release.
    3. Tag (v0.X.Y-beta.Z) and push the tag → CI workflow publishes via OIDC.
    4. Verify tag landed on remote: git ls-remote origin refs/tags/<tag>.
    5. Monitor CI with `gh run watch`; never publish from dev host.
  distribution: |
    Two channels:
    1. Claude Code plugin via marketplace.json + plugin.json.
    2. npm CLI via `npx skillwiki install`.
    Plugin cache doesn't auto-update on test hosts — git fetch + reset + reinstall.
  cli_fallback: |
    When the installed `skillwiki` binary returns a placeholder, use
    `npx tsx packages/cli/src/cli.ts <command>` (set in cli_entry_override).
```
