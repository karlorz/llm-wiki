---
name: using-skillwiki
description: Invoke when vault, wiki, knowledge-base, or SkillWiki setup work arises — maps skillwiki skills, dev-loop alignment, adaptive workflow profiles, and vault routing. Do not invoke for unrelated coding or creative tasks.
---
*Note: If executing as a background subagent, skip this skill section.*

# using-skillwiki
You have skillwiki — a project-aware Karpathy-style knowledge base for agent harnesses.

## Last Hook Gate (SessionStart)

This skill is activated by the plugin during startup and clear lifecycle
events, plus the harness-specific resume/compact event where supported.
Use this section as procedural planning guidelines:

1. Read the injected Project Workflow Profile before choosing orchestration or
   provider skills. Installation proves availability, never activation.
2. For `native`, use the host agent's built-in planning and execution. For
   `guided`, add only targeted structure. Neither profile forces Superpowers
   or `EnterPlanMode` gating.
3. For explicit `full`, run the complete configured provider/pipeline. Gate
   `EnterPlanMode` with `wiki-gate-plan-mode` only when that explicit workflow
   uses Superpowers or TDD planning.
4. If workflow status is unresolved, fail closed for workflow execution; do
   not infer `full` from installed skills or provider names.
5. Always apply the PRD bridge: spec/plan outputs go to vault work-item paths,
   never `docs/superpowers/`.

## Activation File (Cross-Harness Alternative to SessionStart)

**Claude Code** and **Codex** activate SkillWiki via the plugin SessionStart hook (`hooks/session-start` / `hooks/session-start-codex`). Do **not** install activation markers into `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md` when the plugin is present — that double-injects context and pollutes user-scope instruction files.

On harnesses where SessionStart `additionalContext` does **not** fire (**Grok**), SkillWiki activation context is delivered via a compact file. Run `npm run install:activation` from the llm-wiki repo to install:

- `~/.grok/skillwiki.md` — compact derivative covering identity, CLI probe, skill map, PRD bridge, fail-closed boundary, and drift warning.
- `~/.grok/AGENTS.md` — prepended with a marker-wrapped reference: `Read @~/.grok/skillwiki.md for SkillWiki activation context.`

Default install is **Grok only**. Re-running `install:activation` also **removes** any prior Claude/Codex activation marker and matching `skillwiki.md` (cleanup for the earlier dual-target installer). Opt-in fallbacks only when the plugin SessionStart path is unavailable:

- `npm run install:activation -- --with-claude` — `~/.claude/skillwiki.md` + `CLAUDE.md` marker `Read @~/.claude/skillwiki.md …`
- `npm run install:activation -- --with-codex` — `~/.codex/skillwiki.md` + `AGENTS.md` marker `Read @~/.codex/skillwiki.md …`

The activation file is self-contained literal text (ADR-3). On harnesses with `@file` import support, `@~/.grok/skillwiki.md` (or the Claude/Codex home path) is inlined. On Grok (no `@file` support), `read_file` the exact path `~/.grok/skillwiki.md`. Never `~/skillwiki.md`. Never a cwd-relative `skillwiki.md`. If that file is missing, say activation is absent and suggest `npm run install:activation` from the llm-wiki repo; do not create a home-level `skillwiki.md`.

The compact `~/.grok/skillwiki.md` is the session-start context. This full skill is for vault/wiki/setup work only — do not load it at the start of an unrelated session.

The template lives at `packages/skills/using-skillwiki/activation.md`. Run `npm run install:activation:check` to verify the Grok install matches the template and that Claude/Codex are not still carrying the activation block. `skillwiki doctor` reports a warn on a missing file, a stale `@skillwiki.md` marker, or compact-file drift.

## When to Use These Skills
Invoke a skillwiki skill when the user:
- Wants to create, build, or start a vault/wiki/knowledge base
- Mentions ingesting sources, reading URLs into notes, converting content
- Asks to search, query, or find information in their vault
- Wants a health check or lint on their vault
- Mentions crystallizing a session into a note
- Talks about project workspaces, ADRs, or distillation
- Wants to quickly capture an idea, bug, task, or note without interrupting their workflow
- Wants to archive or clean up old vault pages
- Wants to hard-delete a vault path without snapshot resurrection (`wiki-remove`)
- Needs to detect source drift or re-ingest updated content
- Has a spec/plan in a non-skillwiki format (CodeStable, RFC, AIDE)
- Asks about their skillwiki configuration or setup health
- Wants to sync vault changes to/from a git remote
- Wants to visualize the vault graph as an Obsidian Canvas
- Wants to run a research scan of repo and vault health

## Vault Structure
A skillwiki vault has three layers. The canonical architecture lives in `SCHEMA.md` at the vault root — read it before creating any new directories.
**Layer 1 — Raw (`raw/`):** Immutable evidence. Existing content/frontmatter is never autonomously rewritten or removed. Attended structural workflows may rename, relocate, archive, or deduplicate only when exact bytes remain somewhere under `raw/`. Permanent disposal requires explicit exact-target user intent. `raw/transcripts/` is the ad-hoc capture point for meeting notes and unprocessed ideas.
```
raw/
├── articles/             # Active Web articles and clippings
├── papers/               # Active PDFs and papers
├── transcripts/          # Active meeting notes and ad-hoc captures
├── assets/               # Stable flexible asset pool; no fixed internal taxonomy
├── archived/{articles,papers,transcripts}/
└── duplicates/{articles,papers,transcripts}/
```
Use explicit vault-root asset embeds such as `![[raw/assets/example/diagram.png]]`. Agents may choose flat or URL-friendly nested paths. Once an immutable capture references an asset, that path freezes; routine source archive/dedup never moves the asset. Remote images remain external dependencies unless separately captured.
Raw frontmatter:
```yaml
---
source_url: https://…
ingested: YYYY-MM-DD
sha256:          # computed by skillwiki hash over body bytes after closing ---
---
```
**Layer 2 — Typed Knowledge:** `entities/`, `concepts/`, `comparisons/`, `queries/`, `meta/`. Agent-owned pages with `^[raw/...]` citation markers at paragraph-end. Global scope — project association via `provenance_projects:` frontmatter, not directory nesting.
**Layer 3 — Project Workspaces (`projects/{slug}/`):** Per-project lifecycle directories with `work/` (spec + plan + retro), `compound/` (distilled lessons/patterns), `architecture/` (ADRs), and `history/` (archived specs/plans).
**No `inbox/` directory.** Ad-hoc captures go to `raw/transcripts/` or directly into a project work item via `proj-work`. Do not invent new top-level directories — extend Layer 2 via SCHEMA.md tag taxonomy if needed.

## Sensitive Content Policy
Vault content must not contain live credentials, access keys, tokens, passwords, cookies, bearer headers, private keys, or other authenticating secrets. This includes development-only and local-only credentials. Redact values before filing using `[REDACTED:<kind>]` or `[REDACTED:<kind>:<fingerprint>]`. If a source contains live secrets, stop and ask for a redacted source or explicit rotation/remediation direction; do not preserve the secret in `raw/`.

## Typed-Page Publication Contract

All new or updated typed-knowledge and meta pages MUST be published through
`skillwiki page publish`. Compose the complete page at an unpublished temporary
path, run publisher dry-run, then run the same command with `--write`.

- Do not directly create or edit the final typed-page path.
- Do not directly update `index.md` or append the page's structural log entry.
- If `skillwiki page publish --help` is unavailable, fail closed and leave the
  result unpublished; update the active SkillWiki CLI/plugin channel first.
- `skillwiki validate --apply` is a legacy repair/compatibility path, not the
  new-page publication path.
- Non-typed project work items and immutable raw sources keep their existing
  workflows.


## Managed Vault Mutation Contract

Before a managed vault mutation, invoke the managed SkillWiki command while the draft remains outside the authoritative target path. The command resolves fleet authority, refuses existing unmerged/review-required state, converges an authorized Git writer, freezes the base OID, and only then applies the write. Do not run `git pull --rebase --autostash` after placing the authoritative change in the live worktree. Do not edit root `index.md` or root `log.md` directly; projection and log commands own those compatibility files.

### Managed write / 0.10.1 migration troubleshooting

After upgrading to skillwiki **≥0.10.1** (or when managed write fails):

1. Run `skillwiki doctor` — checks `vault_sync_pull_helper` and `vault_sync_review_required_journals`.
2. If pull helper is missing: install `skillwiki@0.10.1+` (helper must resolve from `dist/vault-sync/scripts/`) and/or redeploy vault-sync host install. Last-resort override: `SKILLWIKI_VAULT_SYNC_PULL_HELPER` pointing at `wiki-pull-with-auto-resolve.sh` under host vault-sync `bin/` (macOS Application Support or Linux `~/.local/share/vault-sync/bin`).
3. If preflight reports `review-required` on a **clean** worktree: `skillwiki sync journal list`, then `skillwiki sync journal clear-stale --dry-run`, then `clear-stale` without dry-run. Managed preflight automatically supersedes a handoff when its `target_oid` is already an ancestor of `HEAD` and Git has no active sequencer or unmerged paths; unrelated dirty WIP is preserved. When the same incident also left a dead-owner managed-write lock, that preflight reclaims it with a recovery record in the same invocation. Live owners, active sequencers/unmerged paths, missing/non-ancestor targets, and remaining review-required journals still fail closed.
4. **Protected snapshotter stale-journal cleanup (v0.10.14+):** On a known protected snapshotter (sg01) where `sync journal clear-stale` is blocked by `PROTECTED_SNAPSHOTTER_WRITE_BLOCKED`, use the attended one-shot maintenance authority instead: `skillwiki snapshot-maintenance journal clear-stale <snapshot-worktree> --dry-run --reason "<operator reason>"` to produce a state-bound approval ID, then `skillwiki snapshot-maintenance journal clear-stale <snapshot-worktree> --approve <id> --reason "<same reason>"` on an attended TTY to execute. This requires the exact configured snapshot worktree, the production snapshot flock, and recomputes the plan under the flock; it is the only allowlisted mutation across the protected boundary. No generic force flag or env bypass exists.
5. After `skillwiki update` across 0.10.1, read the printed Migration 0.10.1 notes.

Also mirror these pointers in vault-presync / vault-sync-status skills when operating pull/push.

- typed pages: `skillwiki page publish <draft> <vault> --target <path>` then the same command with `--write`
- archive: `skillwiki archive <path> <vault>`
- pending source inventory: `skillwiki sources pending <vault>`
- attended compile-turn: `skillwiki sources compile claim|release|published|status`
- post-compile reviews: `skillwiki sources review` / `skillwiki sources reviews`
- editorial disposition: `skillwiki sources disposition <exact-raw-path> <vault> ...`
- exceptional raw disposal: `skillwiki sources dispose <exact-raw-path> <vault> --reason ...` then attended `--write --approve <token>`
- ad-hoc structural log: `skillwiki log-append <vault> --content '<entry>'` (Release A dual-write) or event materialization (Release B)
- project/root index: `skillwiki project-index <slug> <vault> --apply` and `skillwiki index rebuild <vault> --write` only through managed commands
- log projection: `skillwiki log materialize <vault> [--write]`
- paired projections: `skillwiki projections materialize <vault> [--write]`


## CLI probe and failsafe (vault-mutating skills)

Vault fleets that combine S3 + GitHub need an explicit delete-intent path. Prefer the skillwiki CLI; when it is missing, agents that still have **git/gh access to the private vault remote** use **FAILSAFE-GIT**.

1. Prefer `skillwiki <subcommand> --help` when the skill requires the CLI.
2. If skillwiki is missing/unusable but `git` (and optionally `gh`) can reach the private vault remote (`fleet.yaml` `vault_remote` / `origin` → `karlorz/wiki`):
   - Use **FAILSAFE-GIT** documented in the skill (tombstone under `meta/delete-intents/` + commit + push). Applies to `wiki-remove` and intentional archive/delete paths.
3. If neither skillwiki nor git/gh private-repo access works: **FAIL CLOSED**.
   Never bare `rm` / bare `git rm` as a fleet delete (snapshot will resurrect from S3).
4. Do not auto `npm install -g` skillwiki in headless/goal/satellite sessions.
5. Delete-intent schema: `vault-delete-intent/v1` JSON under `meta/delete-intents/` (see `wiki-remove`). Git is SSOT for path absence; S3 is a working cache.

## Portable Source References
The vault is shared across hosts, so host-local absolute paths are not durable source identity.

- Prefer commit-pinned GitHub URLs when the source file is in a pushed repository and the commit is known.
- Otherwise prefer repo-relative identity in prose, such as repo slug + relative path.
- Use vault-relative references or `[[wikilinks]]` for pages already inside the wiki.
- Keep host-local absolute paths (`/Users/...`, `/home/...`, `file:///...`) only as clearly labeled observations such as `Observed on host: ...`, not as canonical `Source file:` or `Source inspected:` lines.
- Do not use markdown links to local vault files when a `[[wikilink]]` should be used instead.

### Ad-hoc capture: three entry points
| Entry | When | What happens |
|-------|------|-------------|
| `/wiki-add-task <text>` | You're in a Claude session | Creates `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md` with ad-hoc capture frontmatter |
| Filesystem drop | You're NOT in a Claude session (Obsidian, editor, sync) | Create a new `.md` file in `raw/transcripts/` — dev-loop discovers it on next cycle; do not edit it after capture |
| Dev-loop discovery | Automatic, next cycle | Scans `raw/transcripts/` for new files since last cycle, surfaces as claimable work |

## Skill Map
| Skill | When to Invoke |
|-------|----------------|
| `wiki-init` | Bootstrap a vault and install `_Templates/web-clipper/llm-wiki-clippings.json` plus import guidance |
| `wiki-ingest` | Convert URLs, files, or pasted text into typed-knowledge pages |
| `wiki-query` | Search typed knowledge by default; explicitly requested fresh/raw evidence uses the separate pending channel |
| `wiki-lint` | Vault health and lint checks; use `health` for whole-system reports and `lint --summary` for bounded lint buckets |
| `wiki-crystallize` | Distill the current working session into a typed-knowledge page |
| `wiki-audit` | Verify raw provenance references and source frontmatter integrity |
| `wiki-archive` | Archive typed pages, or attended preserve-move exact raw sources under `raw/archived/` |
| `wiki-remove` | Remove maintained pages; exact raw disposal uses the separate attended `sources dispose` flow |
| `wiki-reingest` | Detect drift in raw sources (sha256 comparison) and re-ingest updated content |
| `wiki-add-task` | Quick-capture ideas, bugs, tasks, notes into `raw/transcripts/` without leaving the current workflow |
| `wiki-adapter-prd` | Map foreign PRD formats (CodeStable, RFC, AIDE, Hermes) into vault pages |
| `proj-init` | Bootstrap a project workspace (README, requirements, architecture) |
| `proj-work` | Open or run a work item under a project's work/ directory |
| `proj-distill` | Distill project compound entries into vault concept pages |
| `wiki-sync` | Safely sync vault git repository — push/pull with lint guards and conflict resolution |
| `wiki-canvas` | Generate Obsidian Canvas visualization from vault graph data |
| `proj-decide` | Write an Architectural Decision Record (ADR) |
| `wiki-gate-plan-mode` | Toggle EnterPlanMode gating — force brainstorming then proj-work instead of built-in plan mode |
| `dev-loop:research` | Research agent for dev-loop IDLE — scans repo + vault health, outputs prioritized work-item recommendations (formerly `/dev-loop-research`) |

## dev-loop Alignment

Use these skills as the knowledge layer in dev-loop. The loop remains
capability-based: resolve `WORKFLOW_PROFILE` first, then branch on capabilities
(`BACKEND_CAPS`, `PRD_CAPS`), not backend names.

Typical sequence with PRD enabled:
`REFRESH → QUERY → WORK → SPEC → PLAN → EXECUTE → SIMPLIFY → MERGE → SAVE → RETRO`.

- `QUERY/WORK/SAVE/RETRO` map naturally to `wiki-query`, `proj-work`, `wiki-crystallize`, and vault logs.
- `SIMPLIFY` is a quality gate before merge; keep it in the loop even for small changes.
- For no-work cycles, run maintenance (`wiki-lint`, `wiki-audit`, `proj-distill`, `dev-loop:research`).

## Workflow Profile Compatibility

Use the resolved workflow policy from `.claude/dev-loop.config.md` and the
SessionStart context as the source of truth:

- `native` defaults to `single-pass` and uses host-native planning,
  implementation, tools, and subagents. Installed providers stay inactive
  unless explicitly selected for a stage.
- `guided` defaults to `tdd-first` and adds only targeted planning, TDD, or
  provider capabilities. It does not imply the complete Superpowers sequence.
- `full` defaults to `full` and runs the complete compatibility workflow. It
  is explicit-only, including the legacy compatibility signal
  `prd_pipeline: full` when no newer workflow policy overrides it.
- `workflow_selection: adaptive` may choose `native` or `guided`, never
  `full`. `workflow_selection: fixed` requires `workflow_profile`.
- Invalid policy is unresolved and fail-closed. Goal, headless, CI, and
  satellite sessions do not prompt for a replacement policy.

`prd_layer` remains an independent provider-capability registry and
`prd_pipeline` remains an independent stage-template override. Provider or
cache discovery cannot select a workflow profile. Regardless of profile,
route generated spec and plan artifacts through `proj-work`, preserve
SkillWiki provenance, and keep the independent `simplify:simplify` review gate
for code changes.

## CLI Backbone
All skills are backed by the `skillwiki` CLI — a deterministic tool with no LLM calls. It handles path resolution, config management, validation, health reporting, and linting. Skills invoke it via Bash for the mechanical parts and use the active agent for the creative parts.
Key CLI subcommands: `init`, `health`, `lint`, `config`, `doctor`, `path`, `lang`, `install`, `fleet context`, `fleet validate`, `graph build`, `query`, `sources pending`, `sources compile`, `sources review`, `sources reviews`, `sources disposition`, `sources dispose`, `archive`, `remove`, `drift`, `dedup`, `compound`, `tag-sync`, `tag reconcile`, `page publish`, `sync status`, `seed`, `stale`, `claim`, `claims audit`, `observe`, `canvas generate`, `mcp`.
Optional read-only MCP (`skillwiki mcp`) exposes pending/compile/review list tools. Do not use MCP for compile claim, publish, or review writes.
`skillwiki claim` binds a transcript to a work item only through an exact `raw/transcripts/...` path in `source:` / `sources:` / `closes:`. A `--project` that contradicts the capture's explicit project is rejected. `skillwiki stale --project` uses exact normalized slugs, not substring matching. `skillwiki claims audit` is the read-only integrity report for duplicate, malformed, dangling, cross-project, and unbacked claims; it never rewrites captures or work items.

Run `skillwiki health <vault> --out /tmp/skillwiki-health.json --no-fail` for a bounded whole-system report that includes the nonblocking source-lifecycle backlog. Pending captures are informational and do not make health fail. Run `skillwiki lint <vault> --summary` for lint-only bucket counts with capped examples and details commands. Run `skillwiki doctor` to diagnose setup/runtime issues only. Run `skillwiki config list` to see current configuration.

## Runtime Host Context and Fleet Freshness
Resolve the active project vault with `skillwiki path` first. Then pass that exact path to `skillwiki --human fleet context <vault>` for host identity and safety guidance. `fleet context` is authoritative for host identity. It overrides stale injected SessionStart context, remembered workspace context, and prior conversation summaries. `fleet context` is local and network-free; it reports `identity_status`, resolver trace, warnings, and the fact that remote freshness was not checked.

Do not substitute infrastructure mirrors such as `~/wiki-git` or other snapshot worktrees for the project vault just to inspect fleet status. Those paths are snapshot infrastructure unless `skillwiki path` itself resolves there.

On snapshotter hosts, `protected: true` does not by itself mean the live vault is read-only for agent authoring. Treat the resolved `skillwiki path` as the live authoring vault when the host policy allows it, and treat snapshot worktrees such as `~/wiki-git` as protected infrastructure unless the user explicitly asks for snapshot maintenance.

Use the local identity check for ordinary runtime context:
```bash
VAULT="$(skillwiki --human path | sed 's/ (via.*//')"
skillwiki --human fleet validate "$VAULT/projects/llm-wiki/architecture/fleet.yaml"
skillwiki --human fleet context "$VAULT"
```

Use the remote freshness flow before SSH, sync, deploy, install/uninstall, snapshot, protected-host work, editing `fleet.yaml`, or claiming "fleet is up to date":
```bash
VAULT="$(skillwiki --human path | sed 's/ (via.*//')"
git -C "$VAULT" fetch origin main --prune
skillwiki --human sync status "$VAULT"
skillwiki --human fleet validate "$VAULT/projects/llm-wiki/architecture/fleet.yaml"
skillwiki --human fleet context "$VAULT"
```

If `identity_status` is `unknown` or `invalid`, treat the runtime as ephemeral: do not infer SSH/self aliases, sync authority, deploy authority, or protected-host permissions. Rerun with `--host-id <id>` only after the user confirms the current machine is that named fleet host.

## Session Kind Policy

Before asking questions or running scheduled maintenance, resolve the session kind through the shared `session-kind` policy when the CLI/runtime exposes it.

- `interactive`: prompts are allowed.
- `headless`: prompts are forbidden; use recorded defaults or fail closed.
- `goal`: prompts are forbidden; run only automation-ready work or explicitly approved defaults.
- `satellite`: prompts are forbidden; run only host/profile-allowed jobs and fail closed on unsafe authority.

## Typical Workflow
1. **Init** (`wiki-init`) — create vault, set domain and taxonomy
2. **Ingest** (`wiki-ingest`) — add sources, build pages
3. **Query** (`wiki-query`) — search typed knowledge; explicitly include pending captures for fresh/raw intent
4. **Lint** (`wiki-lint`) — periodic health checks
5. **Crystallize** (`wiki-crystallize`) — save session insights as pages
6. **Audit** (`wiki-audit`) — verify source integrity
For longer-running project work, use `proj-init` → `proj-work` → `proj-distill` / `proj-decide`.
Maintenance: **Archive** (`wiki-archive`) superseded pages, **Drift** (`wiki-reingest`) to detect stale sources, **Adapter** (`wiki-adapter-prd`) for foreign PRD format ingestion.

## Troubleshooting Version Drift
skillwiki has multiple distribution channels that can drift:
| Channel | Location | Update Command |
|---------|----------|----------------|
| npm CLI | `/usr/local/bin/skillwiki` | `npm install -g skillwiki@latest` |
| npm skills | `/usr/local/lib/node_modules/skillwiki/skills/` | `skillwiki install` only for standalone CLI skill copies; defers when the plugin channel is active |
| Claude plugin | `~/.claude/plugins/cache/llm-wiki/` | `claude plugin update skillwiki@llm-wiki` |
| Codex plugin | `~/.codex/plugins/cache/llm-wiki/` | `codex plugin marketplace upgrade llm-wiki`, then reinstall or restart Codex as needed |
| Grok plugin | `~/.grok/installed-plugins/` (marketplace cache under `~/.grok/marketplace-cache/`) | `grok plugin update skillwiki`, then start a new session or reload plugins |
| Local git dev | source repo checkout | `npm link ./packages/cli` (from repo root) |
**Check versions:** `skillwiki doctor` reports Plugin/CLI version mismatch warnings when installed channels disagree. For Grok, also inspect `~/.grok/installed-plugins/*/.claude-plugin/plugin.json` version and agent frontmatter under `agents/*.md`.
**Plugin channel rule:** Plugin-managed skills and agents are not refreshed with `skillwiki install`. When Claude, Codex, or Grok plugin is installed and enabled, the plugin install root is the skill/agent provider; `skillwiki install` is only a legacy/standalone copier for `~/.claude/skills/`.
**Agent path model:** Runtime agents live at `<plugin-root>/agents/<name>.md` (plugin-dev convention: `agents/` at the plugin root). In this repository the canonical sources are `packages/skills/agents/*.md`; root `agents/` is a materialized mirror for direct root installs. After install there is no `packages/skills/` nesting under the Grok install root — the install root is flattened and typically contains top-level skill folders, nested `skills/` (Codex-compat mirror), `agents/`, `hooks/`, `bin/`, and plugin manifests.
**Agent update rule:** Do not run `skillwiki install` just to refresh plugin-managed skills or agents. If `skillwiki install` reports `deferred_to_plugin: true`, stop there and update the active plugin channel instead: Claude uses `claude plugin update skillwiki@llm-wiki`; Codex uses `codex plugin marketplace upgrade llm-wiki`, then reinstall or restart Codex as needed; Grok uses `grok plugin update skillwiki`. Only use `skillwiki install --force` when the user explicitly wants duplicate CLI-managed copies under `~/.claude/skills/` and accepts that `skillwiki doctor` may report overlap.
**Authoring rule:** `SKILL.md` frontmatter follows the Agent Skills schema: top-level `name` and `description` plus optional schema fields such as `metadata`. Do not put release version fields at the top level of `SKILL.md`; plugin and package release versions live in `plugin.json` and `package.json`.
**Fix:** If developing locally, use the repo source plus `npm link`. If using released versions, update the relevant plugin or npm channel; do not infer release freshness from `SKILL.md` frontmatter.

## Multi-Wiki Profiles
skillwiki supports named wiki profiles for working with multiple vaults. Set `WIKI_DEFAULT` to control which wiki all skills target by default.
**Manage profiles:**
- `skillwiki config set wiki.<name>.path <dir>` — register a profile
- `skillwiki config set default <name>` — set active profile
- `skillwiki config list --profiles` — list all profiles
- `skillwiki --wiki <name> lint` — override per-command
**Project-local override:** Place a `./skillwiki/.env` in a project root to bind that project to a specific wiki. Skills will use it automatically when running from that directory.

## PRD Bridge — Redirect Spec/Plan Output to Vault
When skillwiki is installed, **all spec and plan documents must land in the vault**, not in repo-local directories like `docs/superpowers/`. This applies to brainstorming, grill-me, and any foreign PRD template (CodeStable, AIDE, Hermes).

**Architectural brainstorming** (after the human approves the design):
1. Resolve the vault path: `skillwiki path`.
2. Invoke `proj-work` so the work folder exists. If cwd is inside `projects/{slug}/` (or `./skillwiki/.env` binds a project), use that slug. Otherwise use `playground`.
3. Write `spec.md` only at the emitted redirect path.
4. Do not invoke `writing-plans`.
5. Do not git commit from brainstorming.
6. `plan.md` is a later `proj-work` / explicit user step, not a Superpowers plan file.

If the work is UI (layout, mockup, component look, page structure), offer brainstorming `visual-companion.md` at the first UI question as its own message. Offer the companion once. The human may decline. Non-UI work never offers it. Do not auto-open.

**Bounded implementation:** after a bounded design is approved, TDD applies when standalone `test-driven-development` is installed. Do not require the Superpowers plugin.

**Foreign PRD skills** that still default to `docs/superpowers/specs/` or `docs/superpowers/plans/` must use the `proj-work` redirect paths instead. The vault work-item path is the user preference those skills honor.

The `playground` project at `projects/playground/` is the catch-all workspace when no project context exists. Work items that mature can move to a real project later.
**Never create `docs/superpowers/` in any repo.**
