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

## PRD layer

```yaml
prd_layer: superpowers
prd_pipeline: full
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
manifests_count: 7        # bump-version.sh updates 7 manifests (cli, claude-plugin, codex-plugin, skills, shared, root, marketplace)
deploy_script: ""         # sg01 is a plugin-test host, not a deploy target — DEPLOY step is a no-op
remote_hosts: [sg01]      # kept for context (e2e-remote/e2e-plugin targets), not used by DEPLOY step

# Release-trigger policy (consumed by step 10 PUSH)
release_policy:
  auto_bump: true
  channel: beta                          # next bump → 0.6.1-beta.1, then -beta.2, ...; tag pattern v<X.Y.Z>-beta.<N>
  trigger_globs:                          # any committed file matching these globs makes PUSH fire
    - "packages/skills/**"
    - "packages/cli/**"
    - "packages/shared/**"
    - ".claude-plugin/marketplace.json"
    - "scripts/bump-version.sh"
  skip_globs:                              # cycles where ALL committed files match these skip PUSH entirely
    - "raw/**"
    - "concepts/**"
    - "entities/**"
    - "queries/**"
    - "comparisons/**"
    - "meta/**"
    - "projects/**"
    - "_archive/**"
    - "*.md"                               # standalone doc-only commits (CLAUDE.md, README, etc.)
  tag_format: "v{version}"                 # publish.yml matches v[0-9]+.[0-9]+.[0-9]+(-beta.*)
  verify_after_push: true                  # `git ls-remote origin refs/tags/<tag>` + `gh run watch --exit-status`
```

## CI Configuration

```yaml
ci_configured: true                        # .github/workflows/ci.yml present + branch protection on dev
ci_discovery: runtime                       # GitHub branch protection is the source of truth for required checks
ci_workflow: .github/workflows/ci.yml
release_workflow: .github/workflows/publish.yml   # fires on v* tag push via OIDC (no NPM_TOKEN needed)
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
    Sequence (step 10 PUSH — fires when release_policy.trigger_globs match committed files):
    1. Compute next version: read current root package.json version (e.g. 0.6.0),
       then list existing tags `git tag --list 'v<base>-beta.*'`, increment -beta.N
       (e.g. v0.6.1-beta.1, then -beta.2). Stable bumps require explicit user request.
    2. Bump all 7 manifests in lock-step via bump_script.
    3. Commit (`chore: bump version to <X.Y.Z-beta.N>`) and push to dev branch
       — this push IS the plugin release (Claude Code plugin uses HEAD of dev).
    4. Tag `v<version>` and push the tag → publish.yml fires via OIDC → npm publish --tag beta.
    5. Verify tag landed on remote: `git ls-remote origin refs/tags/v<version>`.
    6. Verify CI: `gh run watch --exit-status` on the publish.yml run.
    7. Never run `npm dist-tag add` or `npm publish` locally — OIDC tag routing only.
  release_policy_notes: |
    PUSH (step 10) is intentionally separate from MERGE (step 6b). MERGE always
    commits + pushes/PRs the code change. PUSH bumps + tags + lets CI publish.
    A cycle that only edits vault/, docs, or CLAUDE.md should commit (MERGE)
    but skip PUSH. The trigger_globs / skip_globs lists encode this decision.
  distribution: |
    Two channels:
    1. Claude Code plugin via marketplace.json + plugin.json.
    2. npm CLI via `npx skillwiki install`.
    Plugin cache doesn't auto-update on test hosts — git fetch + reset + reinstall.
  cli_fallback: |
    When the installed `skillwiki` binary returns a placeholder, use
    `npx tsx packages/cli/src/cli.ts <command>` (set in cli_entry_override).
```
