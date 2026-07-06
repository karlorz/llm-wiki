---
name: using-skillwiki
description: Invoke at session start or when knowledge-base tasks arise — maps skillwiki skills, dev-loop alignment, and PRD/TDD routing with plan-mode gate checks
---
*Note: If executing as a background subagent, skip this skill section.*

# using-skillwiki
You have skillwiki — a project-aware Karpathy-style knowledge base for Claude Code.

## Last Hook Gate (SessionStart)

This skill is activated by the plugin during `startup|clear|compact` lifecycle events.
Use this section as procedural planning guidelines:

1. If the task requires spec/plan work, route through PRD skills (not built-in plan mode).
2. If `prd_layer` is `superpowers` or `tdd`, ensure `EnterPlanMode` is gated (`wiki-gate-plan-mode on` or `status` if uncertain).
3. If `prd_layer` is `manual` or `none`, do not force the gate; follow project policy.
4. Always apply the PRD bridge: spec/plan outputs go to vault work-item paths, never `docs/superpowers/`.

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
- Needs to detect source drift or re-ingest updated content
- Has a spec/plan in a non-skillwiki format (CodeStable, RFC, AIDE)
- Asks about their skillwiki configuration or setup health
- Wants to sync vault changes to/from a git remote
- Wants to visualize the vault graph as an Obsidian Canvas
- Wants to run a research scan of repo and vault health

## Vault Structure
A skillwiki vault has three layers. The canonical architecture lives in `SCHEMA.md` at the vault root — read it before creating any new directories.
**Layer 1 — Raw (`raw/`):** Immutable source material. Never modify after ingest. `raw/transcripts/` doubles as the ad-hoc capture point for meeting notes and unprocessed ideas.
```
raw/
├── articles/    # Web articles, clippings
├── papers/      # PDFs, arxiv papers
├── transcripts/ # Meeting notes, interviews, ad-hoc captures
└── assets/      # Images, diagrams referenced by sources
```
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
| Filesystem drop | You're NOT in a Claude session (Obsidian, editor, sync) | Create/edit any `.md` file in `raw/transcripts/` — dev-loop discovers it on next cycle |
| Dev-loop discovery | Automatic, next cycle | Scans `raw/transcripts/` for new files since last cycle, surfaces as claimable work |

## Skill Map
| Skill | When to Invoke |
|-------|----------------|
| `wiki-init` | Bootstrap a new vault — SCHEMA.md, index.md, log.md, ~/.skillwiki/.env |
| `wiki-ingest` | Convert URLs, files, or pasted text into typed-knowledge pages |
| `wiki-query` | Search the vault and synthesize an answer with ranked results |
| `wiki-lint` | Vault health and lint checks; use `health` for whole-system reports and `lint --summary` for bounded lint buckets |
| `wiki-crystallize` | Distill the current working session into a typed-knowledge page |
| `wiki-audit` | Verify raw provenance references and source frontmatter integrity |
| `wiki-archive` | Archive a typed-knowledge page — move to `_archive/`, remove from index |
| `wiki-reingest` | Detect drift in raw sources (sha256 comparison) and re-ingest updated content |
| `wiki-add-task` | Quick-capture ideas, bugs, tasks, notes into `raw/transcripts/` without leaving the current workflow |
| `wiki-adapter-prd` | Map foreign PRD formats (CodeStable, RFC, AIDE, Hermes) into vault pages |
| `proj-init` | Bootstrap a project workspace (README, requirements, architecture) |
| `proj-work` | Open or run a work item under a project's work/ directory |
| `proj-distill` | Distill project compound entries into vault concept pages |
| `wiki-sync` | Safely sync vault git repository — push/pull with lint guards and conflict resolution |
| `wiki-canvas` | Generate Obsidian Canvas visualization from vault graph data |
| `proj-decide` | Write an Architectural Decision Record (ADR) |
| `wiki-gate-plan-mode` | Toggle EnterPlanMode gating — force superpowers planning instead of built-in plan mode |
| `dev-loop:research` | Research agent for dev-loop IDLE — scans repo + vault health, outputs prioritized work-item recommendations (formerly `/dev-loop-research`) |

## dev-loop Alignment

Use these skills as the knowledge layer in dev-loop. The loop remains capability-based:
branch on capabilities (`BACKEND_CAPS`, `PRD_CAPS`), not backend names.

Typical sequence with PRD enabled:
`REFRESH → QUERY → WORK → SPEC → PLAN → EXECUTE → SIMPLIFY → MERGE → SAVE → RETRO`.

- `QUERY/WORK/SAVE/RETRO` map naturally to `wiki-query`, `proj-work`, `wiki-crystallize`, and vault logs.
- `SIMPLIFY` is a quality gate before merge; keep it in the loop even for small changes.
- For no-work cycles, run maintenance (`wiki-lint`, `wiki-audit`, `proj-distill`, `dev-loop:research`).

## PRD/TDD Compatibility

Use `prd_layer` + `prd_pipeline` from `.claude/dev-loop.config.md` as source of truth:

- `superpowers` + `full`: brainstorming/spec/plan/execute/review; route spec+plan through `proj-work`.
- `tdd` + `tdd-first`: plan-first then test-driven execute; still route artifacts through `proj-work`.
- `single-pass` or `debug-only`: may skip formal spec/plan, but if generated they still belong in vault work items.
- `manual` / `none`: no forced PRD skills; preserve skillwiki logging and provenance discipline.

## CLI Backbone
All skills are backed by the `skillwiki` CLI — a deterministic tool with no LLM calls. It handles path resolution, config management, validation, health reporting, and linting. Skills invoke it via Bash for the mechanical parts and use Claude for the creative parts.
Key CLI subcommands: `init`, `health`, `lint`, `config`, `doctor`, `path`, `lang`, `install`, `fleet context`, `fleet validate`, `graph build`, `archive`, `drift`, `compound`, `tag-sync`, `sync status`, `seed`, `stale`, `observe`, `canvas generate`.
Run `skillwiki health <vault> --out /tmp/skillwiki-health.json --no-fail` for a bounded whole-system report that includes doctor, lint, vault-sync, query-readiness, source-freshness, risk flags, and self-check coverage. Run `skillwiki lint <vault> --summary` for lint-only bucket counts with capped examples and details commands. Run `skillwiki doctor` to diagnose setup/runtime issues only. Run `skillwiki config list` to see current configuration.

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
3. **Query** (`wiki-query`) — search and synthesize answers
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
| Local git dev | source repo checkout | `npm link ./packages/cli` (from repo root) |
**Check versions:** `skillwiki doctor` reports Plugin/CLI version mismatch warnings when installed channels disagree.
**Plugin channel rule:** Plugin-managed skills are not refreshed with `skillwiki install`. When Claude or Codex plugin is installed and enabled, the plugin cache is the skill provider; `skillwiki install` is only a legacy/standalone copier for `~/.claude/skills/`.
**Agent update rule:** Do not run `skillwiki install` just to refresh plugin-managed skills. If `skillwiki install` reports `deferred_to_plugin: true`, stop there and update the active plugin channel instead: Claude uses `claude plugin update skillwiki@llm-wiki`; Codex uses `codex plugin marketplace upgrade llm-wiki`, then reinstall or restart Codex as needed. Only use `skillwiki install --force` when the user explicitly wants duplicate CLI-managed copies under `~/.claude/skills/` and accepts that `skillwiki doctor` may report overlap.
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
When skillwiki is installed, **all spec and plan documents must land in the vault**, not in repo-local directories like `docs/superpowers/`. This applies to PRD and TDD workflows (superpowers, codestable, AIDE, Hermes, manual templates).
**Rule:** Before a PRD skill writes a spec or plan file, redirect its save path:
1. Resolve the vault path: `skillwiki path`
2. If the cwd is inside a project (check for `projects/{slug}/` via `skillwiki path --init-time` or look for `./skillwiki/.env`), use that project's work directory
3. Create or locate the work item via `proj-work`, which emits redirect paths for `spec.md` and `plan.md`
4. Pass those vault paths to the PRD/TDD skill as its save location
**Concrete overrides for superpowers:**
- `superpowers:brainstorming` step 6: override `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` → vault work-item `spec.md` path from `proj-work`
- `superpowers:writing-plans` header: override `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` → vault work-item `plan.md` path from `proj-work`
Both skills say "User preferences for spec location override this default" — the vault work-item path IS the override. Apply the same override pattern to any TDD-oriented planner that emits spec/plan artifacts.
**If no project context exists** (standalone vault, not inside a project), default to the `playground` project slug. Invoke `proj-work` with `playground` as the slug so redirect paths are emitted normally and the PRD bridge chain works. The `playground` project is a pre-initialized catch-all workspace at `projects/playground/` for exploratory work, experiments, and unclassified features. Work items that mature can be moved to a real project later.
**Never create `docs/superpowers/` in any repo.**
