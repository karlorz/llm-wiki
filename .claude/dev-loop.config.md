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
release_branch: main
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

## Vault Write Hygiene

```yaml
vault_auto_commit: true

vault_sync:
  peer_aware: true
  lock_timeout_seconds: 30
  retry_budget: 3
  presync_skill: auto-detect
```

## PRD layer

```yaml
prd_layer: superpowers
prd_pipeline: full

prd_disciplines:
  - skill: superpowers:test-driven-development
    when: execute
    mode: mandatory
    include_paths:
      - "packages/cli/src/cli.ts"
      - "packages/cli/src/commands/**"
      - "packages/shared/src/schemas.ts"
      - "packages/shared/src/exit-codes.ts"
      - "packages/skills/**"
      - "packages/codex-skills/**"
      - "skills/**"
      - "agents/**"
      - "hooks/**"
      - ".claude-plugin/**"
      - ".agents/plugins/marketplace.json"
      - "plugin.json"
      - "scripts/release.sh"
      - "scripts/materialize-plugin-assets.sh"
      - "scripts/verify-manifests.sh"
      - "packages/vault-sync/**"
      - "packages/cli/src/utils/safe-write.ts"
      - "packages/cli/src/utils/sync-lock.ts"
      - "packages/cli/src/utils/log-lock.ts"
      - "packages/cli/src/commands/sync.ts"
      - "packages/cli/src/commands/drift.ts"
  - skill: superpowers:test-driven-development
    when: execute
    mode: advisory
  - skill: superpowers:systematic-debugging
    when: failure
    mode: reactive
```

## Interview

```yaml
interview:
  setup:
    skill: setup-dev-loop
  work_item:
    default: native
    upgrade: grill-me
    source: mattpocock/skills
    install: "npx skills@latest add mattpocock/skills --skill grill-me -a claude-code -g -y"
    trigger: auto
    goal_override: never
```

## Critical Paths

```yaml
critical_paths:
  cli_contracts:
    code:
      - "packages/cli/src/cli.ts"
      - "packages/cli/src/commands/**"
      - "packages/shared/src/schemas.ts"
      - "packages/shared/src/exit-codes.ts"
    vault:
      - "config-and-doctor"
      - "devops-automation-patterns"
    history_pins:
      - "N1-N18 canonical CLI invariants: stable exit codes, Result<T> envelopes, --human exit-code parity, immutable raw files"
      - "2026-05-30: safeWritePage/log-lock doctor metrics and body-shrink guards"
  plugin_distribution:
    code:
      - "packages/skills/**"
      - "packages/codex-skills/**"
      - "skills/**"
      - "agents/**"
      - "hooks/**"
      - ".claude-plugin/**"
      - ".agents/plugins/marketplace.json"
      - "plugin.json"
      - "scripts/release.sh"
      - "scripts/materialize-plugin-assets.sh"
      - "scripts/verify-manifests.sh"
      - ".github/workflows/ci.yml"
      - ".github/workflows/publish.yml"
    vault:
      - "plugin-distribution"
      - "distribution-channels"
      - "codex-plugin-skills-subtree-layout"
      - "agent-plugin-discovery-pattern"
      - "claude-code-plugin-update-workflow"
    history_pins:
      - "2026-06-04: materialized plugin mirrors must be regenerated and verified"
      - "Version bump syncs 12 manifests across CLI, plugin, package, marketplace, vault-sync, and root agy channels"
  vault_sync_safety:
    code:
      - "packages/vault-sync/**"
      - "packages/cli/src/utils/safe-write.ts"
      - "packages/cli/src/utils/sync-lock.ts"
      - "packages/cli/src/utils/log-lock.ts"
      - "packages/cli/src/commands/sync.ts"
      - "packages/cli/src/commands/drift.ts"
    vault:
      - "destructive-rclone-sync-antipattern"
      - "wiki-sync-rebase-conflict-storm-pattern"
      - "multi-writer-git-sync-conflict-prevention"
      - "vault-sync-mechanisms-tried"
    history_pins:
      - "2026-05-23: rclone sync without --max-delete mass-deleted files from the GitHub snapshot path"
      - "sg01 is protected and plugin E2E must stay read-only there"
      - "Single-writer git invariant: sg01 is the only snapshotter in fleet.yaml"
```

## Fact-Check Tier

```yaml
fact_check:
  enabled: true
  source_order:
    - local_repo
    - context7
    - vault_query
    - web_search
  web_tools:
    primary: mcp__grok-search__web_search
    deep_fetch: mcp__grok-search__web_fetch
    site_map: mcp__grok-search__web_map
    plan_first: mcp__grok-search__plan_intent
  evidence_contract:
    require_sources_used_section: true
    cite_session_id: true
  triggers:
    - "version claims"
    - "deprecation notices"
    - "CVE checks"
    - "plugin marketplace behavior"
    - "OpenAI/Codex API behavior"
```

## Idle Deep-Research

```yaml
idle_deep_research:
  enabled: true
  skill: deep-research
  trigger:
    when: idle_after_mechanical_scan
    if: no_p2_or_higher_findings
    cooldown: every_3rd_idle_cycle
    max_per_day: 4
  topic_seeds:
    - "skillwiki CLI contract drift and missing command coverage"
    - "cross-agent plugin distribution compatibility"
    - "vault sync safety and destructive sync regression prevention"
    - "Codex and Claude plugin marketplace behavior changes"
    - "skillwiki vault lint signal quality and false positives"
  topic_selection:
    bias_toward: critical_paths
    skip_if_recent_query_page_exists: 14d
  output_mode: vault
  budget:
    web_searches: 3
    deep_fetches: 3
    context7_calls: 3
  followups:
    on_finding: schema_compatible_vault_queue
    p_score_default: P3
```

## Investigate

```yaml
investigate:
  max_items: 5
  topic_seeds: []  # falls back to idle_deep_research.topic_seeds
```

## Preflight

```yaml
preflight:
  enabled: true
  default_limit: 5
  default_lanes: [work, captures, hygiene]
  require_approved_spec_and_plan: true
  unattended_not_ready_behavior: skip
  defaults:
    compatibility_policy: "Platform compatibility changes are additive unless explicitly scoped otherwise."
```

## Browser Verification

No `browser_verification` block is configured. No browser framework or Playwright config was detected in this repo, so dev-loop should skip the browser gate.

## Reactive Debugging

```yaml
reactive_debugging:
  enabled: true
  auto_retry_attempts: 2
  evidence_dir: .claude/dev-loop-debug/
  evidence_capture:
    - "npm test 2>&1 | tee {evidence_dir}/{cycle}-test.log"
    - "git diff > {evidence_dir}/{cycle}-diff.patch"
    - "git log --oneline -5 > {evidence_dir}/{cycle}-commits.log"
  fact_check_tool: mcp__grok-search__web_search
  escalate_after:
    consecutive_idle_cycles: 3
    same_error_signature: true
  escalation_action: surface_p1_finding
```

## Code Review

```yaml
code_review:
  parallel: true
  codex:
    enabled_in_normal: false
    enabled_in_high: false
    agent: dev-loop:codex-review-worker
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
release_script: ./scripts/release.sh
publish_via: ci-tag-trigger
manifests_count: 13       # bump-version.sh updates 13 manifests across CLI, plugin, package, marketplace, vault-sync, agent-memory-trends, and root agy channels
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
    - "packages/vault-sync/**"
    - ".claude-plugin/marketplace.json"
    - "scripts/bump-version.sh"
    - "scripts/release.sh"
    - ".github/workflows/ci.yml"
    - ".github/workflows/publish.yml"
  # NOTE: scripts/e2e-*.sh is intentionally NOT in trigger_globs.
  # E2E assertion fixes (e.g., doctor warn count updates) are test
  # infrastructure, not shipped artifacts. Cycles that only edit e2e
  # scripts skip PUSH so they don't produce noise releases. If an e2e
  # change rides alongside a feature-bearing change in trigger_globs,
  # the PUSH still fires for the feature and pulls the e2e fix in too.
  # Decision recorded 2026-05-24, closes raw/transcripts/2026-05-24-task-release-policy-trigger-globs-e2e-scripts.md
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
  stable_release_guard: release_script      # stable bumps do NOT publish from main alone; scripts/release.sh must push main + tag
```

## CI Configuration

```yaml
ci_configured: true                        # .github/workflows/ci.yml present; main is the release branch
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
    2. Bump all 13 manifests in lock-step via bump_script.
    3. Commit (`chore: bump version to <X.Y.Z-beta.N>`) and push to main branch
       — this push IS the plugin release (Claude Code plugin uses HEAD of main).
    4. Tag `v<version>` and push the tag → publish.yml fires via OIDC → npm publish --tag beta/latest.
    5. Verify tag landed on remote: `git ls-remote origin refs/tags/v<version>`.
    6. Verify CI: `gh run watch --exit-status` on the publish.yml run.
    7. Stable releases are explicit: after `npm run bump <X.Y.Z>`, commit and tag `v<X.Y.Z>`, then run
       `scripts/release.sh <X.Y.Z> --watch`. A bump commit on main alone only runs CI and updates plugin
       source; it does not publish npm.
    8. Never run `npm dist-tag add` or `npm publish` locally — OIDC tag routing only.
  release_policy_notes: |
    PUSH (step 10) is intentionally separate from MERGE (step 6b). MERGE always
    commits + pushes/PRs the code change. PUSH bumps + tags + lets CI publish.
    A cycle that only edits vault/, docs, or CLAUDE.md should commit (MERGE)
    but skip PUSH. The trigger_globs / skip_globs lists encode this decision.
  distribution: |
    Distribution channels:
    1. Claude Code plugin via marketplace.json + plugin.json.
    2. Codex plugin marketplace via .agents/plugins/marketplace.json + packages/codex-skills.
    3. Antigravity CLI via repo-root plugin.json (`agy plugin install https://github.com/karlorz/llm-wiki`).
    4. npm CLI via `npx skillwiki install`.
    Plugin cache doesn't auto-update on test hosts — git fetch + reset + reinstall.
  cli_fallback: |
    When the installed `skillwiki` binary returns a placeholder, use
    `npx tsx packages/cli/src/cli.ts <command>` (set in cli_entry_override).
```
