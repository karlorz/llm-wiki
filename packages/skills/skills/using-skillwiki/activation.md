# SkillWiki Activation

You have SkillWiki - a project-aware knowledge-base CLI + skill suite for agent harnesses.
This file is loaded at session start. For full operational detail, invoke `/using-skillwiki`.

## CLI Probe

If `skillwiki --help` fails, the CLI is unavailable. Degrade to manual file ops (grep/find) for read-only queries. Fail closed for managed mutations - never write typed pages, index, or log directly.

## When to Route

Invoke a SkillWiki skill when the user: wants vault/wiki/knowledge-base operations, ingests sources or URLs, searches/queries vault content, runs health checks or lint, crystallizes a session, works with project workspaces/ADRs, captures ideas/bugs/tasks, archives pages, removes paths, detects source drift, ingests foreign PRD formats, syncs vault git, or visualizes the vault graph.

## Skill Map

| Skill | When to Invoke |
|-------|----------------|
| `wiki-init` | Bootstrap a vault |
| `wiki-ingest` | Convert URLs/files/text into typed-knowledge pages |
| `wiki-query` | Search typed knowledge |
| `wiki-lint` | Vault health and lint checks |
| `wiki-crystallize` | Distill current session into a typed page |
| `wiki-audit` | Verify raw provenance and source integrity |
| `wiki-archive` | Archive typed pages or preserve-move raw sources |
| `wiki-remove` | Hard-delete vault paths without snapshot resurrection |
| `wiki-reingest` | Detect source drift and re-ingest updated content |
| `wiki-add-task` | Quick-capture ideas, bugs, tasks, notes |
| `wiki-adapter-prd` | Map foreign PRD formats (CodeStable, RFC, AIDE, Hermes) |
| `wiki-sync` | Safely sync vault git repository |
| `wiki-canvas` | Generate Obsidian Canvas visualization |
| `wiki-gate-plan-mode` | Toggle EnterPlanMode gating for superpowers planning |
| `proj-init` | Bootstrap a project workspace |
| `proj-work` | Open or run a work item |
| `proj-distill` | Distill project compound entries into concept pages |
| `proj-decide` | Write an Architectural Decision Record (ADR) |
| `dev-loop:research` | Research scan of repo + vault health |

## PRD Bridge

Route PRD/spec/plan work to `wiki-adapter-prd` and `proj-work`, not `docs/superpowers/`. Spec and plan outputs must land in vault work-item paths. Never create `docs/superpowers/` in any repo.

## Workflow Profiles

Resolve workflow policy before loading provider skills. Profiles are `native`,
`guided`, and explicit-only `full`; selection is `adaptive` or `fixed`.
Adaptive chooses only native or guided. Installation and cache discovery prove
availability, never activation. Native and guided do not force Superpowers or
plan-mode gating. Explicit full may use the complete configured provider flow;
gate plan mode only when that flow actually uses Superpowers/TDD planning.
Invalid fixed policy is unresolved and fail-closed. Noninteractive sessions do
not prompt. Keep workflow profile, `prd_layer` provider, `prd_pipeline` stage
template, SkillWiki provenance, and the independent simplify review gate as
separate concerns.

## Fail-Closed Boundary

Never write typed pages, `index.md`, or `log.md` directly. Never bare `rm` or `git rm` as a fleet delete (snapshot resurrects from S3). Never auto `npm install -g skillwiki` in headless/goal/satellite sessions. If `skillwiki page publish --help` is unavailable, fail closed.

## Sensitive Content

Never commit secrets, credentials, API keys, tokens, passwords, or PII to the vault. Redact using `[REDACTED:<kind>]` before filing.

## Drift Warning

If `skillwiki doctor` mentions a version newer than this file, re-read the full `/using-skillwiki` skill for updated content.

## Canonical Paths

- Full skill (logical): invoke `/using-skillwiki` or read the installed plugin skill at `<plugin-root>/using-skillwiki/SKILL.md` (repository source: `packages/skills/using-skillwiki/SKILL.md`)
- Vault schema: `SCHEMA.md` at the vault root (run `skillwiki path` to resolve)
- Frontier agents (`proj-work`, `proj-decide`): plugin-root `agents/<name>.md` with `model: inherit` — refresh with the active plugin channel (`grok plugin update skillwiki` on Grok)
