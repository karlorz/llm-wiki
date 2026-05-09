---
version: 0.2.1
name: using-skillwiki
description: Invoke at session start or when knowledge-base tasks arise — maps all skillwiki skills and teaches the skillwiki CLI workflow
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
</SUBAGENT-STOP>

# using-skillwiki

You have skillwiki — a project-aware Karpathy-style knowledge base for Claude Code.

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
| `wiki-lint` | Vault health check (stale pages, oversized pages, log rotation) |
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
| `dev-loop-research` | Standalone research agent — scans repo + vault health, outputs prioritized work-item recommendations |

## CLI Backbone

All skills are backed by the `skillwiki` CLI — a deterministic tool with no LLM calls. It handles path resolution, config management, validation, and linting. Skills invoke it via Bash for the mechanical parts and use Claude for the creative parts.

Key CLI subcommands: `init`, `lint`, `config`, `doctor`, `path`, `lang`, `install`, `graph build`, `archive`, `drift`, `compound`, `tag-sync`, `sync status`, `seed`, `stale`, `observe`, `canvas generate`.

Run `skillwiki doctor` to diagnose setup issues. Run `skillwiki config list` to see current configuration.

## Typical Workflow

1. **Init** (`wiki-init`) — create vault, set domain and taxonomy
2. **Ingest** (`wiki-ingest`) — add sources, build pages
3. **Query** (`wiki-query`) — search and synthesize answers
4. **Lint** (`wiki-lint`) — periodic health checks
5. **Crystallize** (`wiki-crystallize`) — save session insights as pages
6. **Audit** (`wiki-audit`) — verify source integrity

For longer-running project work, use `proj-init` → `proj-work` → `proj-distill` / `proj-decide`.

Maintenance: **Archive** (`wiki-archive`) superseded pages, **Drift** (`wiki-reingest`) to detect stale sources, **Adapter** (`wiki-adapter-prd`) for foreign PRD format ingestion.

## Multi-Wiki Profiles

skillwiki supports named wiki profiles for working with multiple vaults. Set `WIKI_DEFAULT` to control which wiki all skills target by default.

**Manage profiles:**
- `skillwiki config set wiki.<name>.path <dir>` — register a profile
- `skillwiki config set default <name>` — set active profile
- `skillwiki config list --profiles` — list all profiles
- `skillwiki --wiki <name> lint` — override per-command

**Project-local override:** Place a `./skillwiki/.env` in a project root to bind that project to a specific wiki. Skills will use it automatically when running from that directory.

## PRD Bridge — Redirect Spec/Plan Output to Vault

When skillwiki is installed, **all spec and plan documents must land in the vault**, not in repo-local directories like `docs/superpowers/`. This applies to any PRD/design skill (superpowers:brainstorming, superpowers:writing-plans, CodeStable, AIDE, Hermes, etc.).

**Rule:** Before a PRD skill writes a spec or plan file, redirect its save path:
1. Resolve the vault path: `skillwiki path`
2. If the cwd is inside a project (check for `projects/{slug}/` via `skillwiki path --init-time` or look for `./skillwiki/.env`), use that project's work directory
3. Create or locate the work item via `proj-work`, which emits redirect paths for `spec.md` and `plan.md`
4. Pass those vault paths to the PRD skill as its save location

**Concrete overrides for superpowers:**
- `superpowers:brainstorming` step 6: override `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` → vault work-item `spec.md` path from `proj-work`
- `superpowers:writing-plans` header: override `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` → vault work-item `plan.md` path from `proj-work`

Both skills say "User preferences for spec location override this default" — the vault work-item path IS the override.

**If no project context exists** (standalone vault, not inside a project), save specs/plans directly under the vault root with the PRD skill's default naming, e.g. `<vault>/specs/YYYY-MM-DD-<slug>.md`.

**Never create `docs/superpowers/` in any repo.**
