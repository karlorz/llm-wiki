     1|---
     2|version: 0.2.1
     3|name: using-skillwiki
     4|description: Invoke at session start or when knowledge-base tasks arise — maps all skillwiki skills and teaches the skillwiki CLI workflow
     5|---
     6|
     7|<SUBAGENT-STOP>
     8|If you were dispatched as a subagent to execute a specific task, skip this skill.
     9|</SUBAGENT-STOP>
    10|
    11|# using-skillwiki
    12|
    13|You have skillwiki — a project-aware Karpathy-style knowledge base for Claude Code.
    14|
    15|## When to Use These Skills
    16|
    17|Invoke a skillwiki skill when the user:
    18|- Wants to create, build, or start a vault/wiki/knowledge base
    19|- Mentions ingesting sources, reading URLs into notes, converting content
    20|- Asks to search, query, or find information in their vault
    21|- Wants a health check or lint on their vault
    22|- Mentions crystallizing a session into a note
    23|- Talks about project workspaces, ADRs, or distillation
    24|- Wants to quickly capture an idea, bug, task, or note without interrupting their workflow
    25|- Wants to archive or clean up old vault pages
    26|- Needs to detect source drift or re-ingest updated content
    27|- Has a spec/plan in a non-skillwiki format (CodeStable, RFC, AIDE)
    28|- Asks about their skillwiki configuration or setup health
    29|- Wants to sync vault changes to/from a git remote
    30|- Wants to visualize the vault graph as an Obsidian Canvas
    31|- Wants to run a research scan of repo and vault health
    32|
    33|## Vault Structure
    34|
    35|A skillwiki vault has three layers. The canonical architecture lives in `SCHEMA.md` at the vault root — read it before creating any new directories.
    36|
    37|**Layer 1 — Raw (`raw/`):** Immutable source material. Never modify after ingest. `raw/transcripts/` doubles as the ad-hoc capture point for meeting notes and unprocessed ideas.
    38|
    39|```
    40|raw/
    41|├── articles/    # Web articles, clippings
    42|├── papers/      # PDFs, arxiv papers
    43|├── transcripts/ # Meeting notes, interviews, ad-hoc captures
    44|└── assets/      # Images, diagrams referenced by sources
    45|```
    46|
    47|Raw frontmatter:
    48|```yaml
    49|---
    50|source_url: https://…
    51|ingested: YYYY-MM-DD
    52|sha256:          # computed by skillwiki hash over body bytes after closing ---
    53|---
    54|```
    55|
    56|**Layer 2 — Typed Knowledge:** `entities/`, `concepts/`, `comparisons/`, `queries/`, `meta/`. Agent-owned pages with `^[raw/...]` citation markers at paragraph-end. Global scope — project association via `provenance_projects:` frontmatter, not directory nesting.
    57|
    58|**Layer 3 — Project Workspaces (`projects/{slug}/`):** Per-project lifecycle directories with `work/` (spec + plan + retro), `compound/` (distilled lessons/patterns), `architecture/` (ADRs), and `history/` (archived specs/plans).
    59|
    60|**No `inbox/` directory.** Ad-hoc captures go to `raw/transcripts/` or directly into a project work item via `proj-work`. Do not invent new top-level directories — extend Layer 2 via SCHEMA.md tag taxonomy if needed.
    61|
    62|### Ad-hoc capture: three entry points
    63|
    64|| Entry | When | What happens |
    65||-------|------|-------------|
    66|| `/wiki-add-task <text>` | You're in a Claude session | Creates `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md` with ad-hoc capture frontmatter |
    67|| Filesystem drop | You're NOT in a Claude session (Obsidian, editor, sync) | Create/edit any `.md` file in `raw/transcripts/` — dev-loop discovers it on next cycle |
    68|| Dev-loop discovery | Automatic, next cycle | Scans `raw/transcripts/` for new files since last cycle, surfaces as claimable work |
    69|
    70|## Skill Map
    71|
    72|| Skill | When to Invoke |
    73||-------|----------------|
    74|| `wiki-init` | Bootstrap a new vault — SCHEMA.md, index.md, log.md, ~/.skillwiki/.env |
    75|| `wiki-ingest` | Convert URLs, files, or pasted text into typed-knowledge pages |
    76|| `wiki-query` | Search the vault and synthesize an answer with ranked results |
    77|| `wiki-lint` | Vault health check (stale pages, oversized pages, log rotation) |
    78|| `wiki-crystallize` | Distill the current working session into a typed-knowledge page |
    79|| `wiki-audit` | Verify raw provenance references and source frontmatter integrity |
    80|| `wiki-archive` | Archive a typed-knowledge page — move to `_archive/`, remove from index |
    81|| `wiki-reingest` | Detect drift in raw sources (sha256 comparison) and re-ingest updated content |
    82|| `wiki-add-task` | Quick-capture ideas, bugs, tasks, notes into `raw/transcripts/` without leaving the current workflow |
    83|| `wiki-adapter-prd` | Map foreign PRD formats (CodeStable, RFC, AIDE, Hermes) into vault pages |
    84|| `proj-init` | Bootstrap a project workspace (README, requirements, architecture) |
    85|| `proj-work` | Open or run a work item under a project's work/ directory |
    86|| `proj-distill` | Distill project compound entries into vault concept pages |
    87|| `wiki-sync` | Safely sync vault git repository — push/pull with lint guards and conflict resolution |
    88|| `wiki-canvas` | Generate Obsidian Canvas visualization from vault graph data |
    89|| `proj-decide` | Write an Architectural Decision Record (ADR) |
    90|| `wiki-gate-plan-mode` | Toggle EnterPlanMode gating — force superpowers planning instead of built-in plan mode |
    91|| `dev-loop-research` | Standalone research agent — scans repo + vault health, outputs prioritized work-item recommendations |
    92|
    93|## CLI Backbone
    94|
    95|All skills are backed by the `skillwiki` CLI — a deterministic tool with no LLM calls. It handles path resolution, config management, validation, and linting. Skills invoke it via Bash for the mechanical parts and use Claude for the creative parts.
    96|
    97|Key CLI subcommands: `init`, `lint`, `config`, `doctor`, `path`, `lang`, `install`, `graph build`, `archive`, `drift`, `compound`, `tag-sync`, `sync status`, `seed`, `stale`, `observe`, `canvas generate`.
    98|
    99|Run `skillwiki doctor` to diagnose setup issues. Run `skillwiki config list` to see current configuration.
   100|
   101|## Typical Workflow
   102|
   103|1. **Init** (`wiki-init`) — create vault, set domain and taxonomy
   104|2. **Ingest** (`wiki-ingest`) — add sources, build pages
   105|3. **Query** (`wiki-query`) — search and synthesize answers
   106|4. **Lint** (`wiki-lint`) — periodic health checks
   107|5. **Crystallize** (`wiki-crystallize`) — save session insights as pages
   108|6. **Audit** (`wiki-audit`) — verify source integrity
   109|
   110|For longer-running project work, use `proj-init` → `proj-work` → `proj-distill` / `proj-decide`.
   111|
   112|Maintenance: **Archive** (`wiki-archive`) superseded pages, **Drift** (`wiki-reingest`) to detect stale sources, **Adapter** (`wiki-adapter-prd`) for foreign PRD format ingestion.
   113|
   114|## Troubleshooting Version Drift
   115|
   116|skillwiki has three distribution channels that can drift:
   117|
   118|| Channel | Location | Update Command |
   119||---------|----------|----------------|
   120|| npm CLI | `/usr/local/bin/skillwiki` | `npm install -g skillwiki@latest` |
   121|| npm skills | `/usr/local/lib/node_modules/skillwiki/skills/` | `skillwiki install` (copies to `~/.claude/skills/`) |
   122|| Claude plugin | `~/.claude/plugins/cache/llm-wiki/` | `claude plugin update skillwiki@llm-wiki` |
   123|| Local git dev | `~/.hermes/skills/llm-wiki/` | `npm link ./packages/cli` (from repo root) |
   124|
   125|**Check versions:** `skillwiki doctor` reports "Plugin/CLI version" mismatch warnings.
   126|
   127|**Common issue:** npm package ships SKILL.md files with older `version:` frontmatter than CLI code. This creates false-positive "version warnings" in `skillwiki doctor` — the CLI is newer but skills report older version.
   128|
   129|**Fix:** If developing locally, use `npm link` from the git repo. If using released versions, wait for maintainer to bump SKILL.md versions in source and republish.
   130|
   131|## Multi-Wiki Profiles
   132|
   133|skillwiki supports named wiki profiles for working with multiple vaults. Set `WIKI_DEFAULT` to control which wiki all skills target by default.
   134|
   135|**Manage profiles:**
   136|- `skillwiki config set wiki.<name>.path <dir>` — register a profile
   137|- `skillwiki config set default <name>` — set active profile
   138|- `skillwiki config list --profiles` — list all profiles
   139|- `skillwiki --wiki <name> lint` — override per-command
   140|
   141|**Project-local override:** Place a `./skillwiki/.env` in a project root to bind that project to a specific wiki. Skills will use it automatically when running from that directory.
   142|
   143|## PRD Bridge — Redirect Spec/Plan Output to Vault
   144|
   145|When skillwiki is installed, **all spec and plan documents must land in the vault**, not in repo-local directories like `docs/superpowers/`. This applies to any PRD/design skill (superpowers:brainstorming, superpowers:writing-plans, CodeStable, AIDE, Hermes, etc.).
   146|
   147|**Rule:** Before a PRD skill writes a spec or plan file, redirect its save path:
   148|1. Resolve the vault path: `skillwiki path`
   149|2. If the cwd is inside a project (check for `projects/{slug}/` via `skillwiki path --init-time` or look for `./skillwiki/.env`), use that project's work directory
   150|3. Create or locate the work item via `proj-work`, which emits redirect paths for `spec.md` and `plan.md`
   151|4. Pass those vault paths to the PRD skill as its save location
   152|
   153|**Concrete overrides for superpowers:**
   154|- `superpowers:brainstorming` step 6: override `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` → vault work-item `spec.md` path from `proj-work`
   155|- `superpowers:writing-plans` header: override `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` → vault work-item `plan.md` path from `proj-work`
   156|
   157|Both skills say "User preferences for spec location override this default" — the vault work-item path IS the override.
   158|
   159|**If no project context exists** (standalone vault, not inside a project), default to the `playground` project slug. Invoke `proj-work` with `playground` as the slug so redirect paths are emitted normally and the PRD bridge chain works. The `playground` project is a pre-initialized catch-all workspace at `projects/playground/` for exploratory work, experiments, and unclassified features. Work items that mature can be moved to a real project later.
   160|
   161|**Never create `docs/superpowers/` in any repo.**
   162|