# CodeWiki — Design Specification

**Date**: 2026-05-03 (revised; supersedes 2026-05-02 v1)
**Status**: Approved for plan generation
**Canonical**: this document. Supersedes the 2026-05-02 v1 spec entirely; see Decision 1. All other CodeWiki design notes in `docs/` are non-normative.
**Repo**: `/Users/karlchow/Desktop/code/llm-wiki`

## TL;DR

A Claude Code skill plugin that builds and maintains **project-aware** Karpathy-style markdown knowledge bases. Two namespaces of skills sharing one Obsidian vault:

- **6 `wiki-*` skills** — knowledge layer (research-driven KB, Hermes-compatible)
- **4 `proj-*` skills** — project layer (per-project lifecycle workspace)

Skills are prompt-only Markdown. Deterministic helpers (frontmatter validation, sha256, fetch-guard, link graph, citation audit) ship as the cross-platform npm package **`skillwiki`** (TypeScript + tsup + Commander + Zod + Vitest, Node ≥ 20). Project work distills upward into the shared knowledge layer via `provenance:` frontmatter — no namespace fragmentation. Vault output remains wire-compatible with Hermes llm-wiki v2.1.0 without migration.

## Design Decisions (locked from brainstorm)

1. **Path A: REPLACE** the prior standalone-skill design. The earlier 2026-05-02 spec (6 skills, no project layer) is superseded; this document is canonical.
2. **Layered Model (Approach 3)**: project compound (concrete) and vault concepts (distilled) coexist as distinct stable kinds — neither is a staging area for the other.
3. **Unified knowledge layer (Option B)**: one set of `entities/concepts/comparisons/queries/`. Origin tracked via `provenance:` frontmatter, not folder split.
4. **Hermes wire-compat preserved** as a hard requirement.
5. **No migration of existing `5️⃣-Projects/` content in v1.** Existing notes are design reference only; transformation deferred post-implementation.
6. **No `purpose.md`, no `views/` folder in v1.** nashsu insights confined to skill behavior, not new files.
7. **Two-prefix skill naming**: `wiki-*` and `proj-*`. No `cs-*` (CodeStable is inspiration, not dependency).
8. **Wikilinks in YAML are quoted strings** per kepano/Obsidian official convention: `"[[name]]"`. Lists use YAML block style for diffability.
9. **TypeScript over bash for utilities.** All deterministic helpers ship as the npm package `skillwiki` (Node ≥ 20, cross-platform). No bash scripts in v1. Skills remain prompt-only; CLI does no LLM calls.
10. **npm workspaces monorepo.** Single repo, two packages: `packages/skills` (prompt-only Markdown) and `packages/cli` (`skillwiki`), with `packages/shared` reserved for v1.2 MCP server.
11. **`skillwiki` package name** — verified available on npm registry. Selected over `codewiki` (Google brand collision), `llm-wiki` (taken), `wikidoc`/`docskill`/`codewik` (also free) for ecosystem fit with SKILL.md tooling.

## Scope

### In v1
- Vault top-level structure (folders + extended SCHEMA/index/log)
- 4 frontmatter schemas (typed knowledge, raw, work items, project compound)
- 14 skill `SKILL.md` files (9 `wiki-*`, 4 `proj-*`, 1 `using-skillwiki`)
- `skillwiki` npm package (TypeScript CLI — originally 8 subcommands, grew to 24+ through lint buckets, config/doctor, archive, drift, and compatibility work. Core 8: `hash`, `fetch-guard`, `validate`, `graph build`, `overlap`, `orphans`, `audit`, `install`)
- Cross-platform installation via `skillwiki install` (replaces previous bash `install.sh`)
- Skill behavior enhancements E2–E5 baked into prompts (no schema impact)
- Vitest test suite for the CLI package

### Deferred to v1.1+
- E1: 2-step chain-of-thought ingest (documented in spec, single-pass ships in v1)
- Auto-mirror frontmatter enums to nested tags (`skillwiki tag-sync` + lint hook)
- Starter Bases `views/` pack
- `purpose.md` directional intent layer
- Multi-format ingest (PDF/DOCX/PPTX/XLSX) — `skillwiki extract` subcommand
- MCP server (`packages/mcp`) wrapping the CLI utilities

## Normative Requirements (v1)

These requirements use RFC 2119 keywords (**MUST**, **SHOULD**, **MUST NOT**). Every implementation task in the plan resolves to one or more of these. Anything not stated here is non-normative; implementers SHOULD prefer the simplest behavior consistent with this section.

### CLI behavior

- **N1.** `skillwiki` subcommands **MUST** emit machine-readable JSON to stdout by default.
- **N2.** `skillwiki` subcommands **MUST** accept a `--human` flag for terminal-readable output. `--human` **MUST NOT** alter exit codes.
- **N3.** Every subcommand **MUST** return a stable, documented exit code per failure class (see Command Contracts).
- **N4.** Every subcommand **MUST** be idempotent or **MUST** explicitly document its non-idempotent side effects.
- **N5.** The CLI **MUST NOT** make LLM API calls in v1.

### Ingest and content integrity

- **N6.** `wiki-ingest` **MUST** invoke `skillwiki fetch-guard` and receive exit code 0 before any remote fetch.
- **N7.** Every generated typed-knowledge page **MUST** pass `skillwiki validate` before `index.md` or `log.md` is updated.
- **N8.** Writes **MUST** follow the order: page(s) → `index.md` → `log.md`. A failure at any step **MUST** stop subsequent writes.
- **N9.** Files in `raw/` **MUST NOT** be modified after ingestion. v1 permits no append-only metadata exceptions.
- **N10.** `skillwiki hash` **MUST** compute sha256 over body bytes after the closing `---`, with no normalization.

### Schema

- **N11.** All four frontmatter schemas **MUST** validate via Zod with field-level error reporting.
- **N12.** Hermes-required fields (`title`, `created`, `updated`, `type`, `tags`, `sources`) **MUST** retain their Hermes names and meanings.
- **N13.** Fields beyond Hermes **MUST** be additive and **MUST** be silently ignored by Hermes parsers (verified by the wire-compat test in Definition of Done).

### Security

- **N14.** `skillwiki fetch-guard` **MUST** fail closed (non-zero exit) on any validation failure.
- **N15.** `skillwiki fetch-guard` **MUST** reject non-`https` schemes, RFC 1918 / link-local / loopback addresses, and known cloud metadata endpoints.
- **N16.** `skillwiki fetch-guard` **MUST** strip credentials (query-param tokens and path-embedded tokens) from URLs before any logging.

### Installer

- **N17.** `skillwiki install` **MUST** be idempotent and **MUST** write a manifest at `.claude/skills/wiki-manifest.json`.
- **N18.** `skillwiki install` **MUST** back up any existing skill files it would overwrite.

## Vault Architecture

### Top-Level

```
vault/
├── SCHEMA.md              # Conventions, frontmatter spec, tag taxonomy (extended)
├── index.md               # Sectioned content catalog (extended with projects/ + meta/)
├── log.md                 # Chronological action log
├── raw/                   # Layer 1: immutable source material
│   ├── articles/
│   ├── papers/
│   ├── transcripts/
│   └── assets/
├── entities/              # Layer 2: typed knowledge (research + project-distilled, unified via provenance)
├── concepts/
├── comparisons/
├── queries/
├── meta/                  # Cross-project synthesis (notes naming ≥2 projects)
└── projects/              # Per-project workspaces
    └── {slug}/
        ├── README.md
        ├── requirements/  # Project-level: what we're building (incl. roadmap docs)
        ├── architecture/  # Project-level: how it's designed (incl. ADRs)
        ├── work/          # Per-work-item dated folders
        │   └── YYYY-MM-DD-{slug}/
        │       ├── spec.md
        │       ├── plan.md
        │       └── log.md
        └── compound/      # Project-local concrete learnings
```

**Layer responsibilities**:
- `raw/` — immutable sources; agent reads but never modifies.
- `entities/concepts/comparisons/queries/` — agent-owned typed knowledge unified across origin via `provenance:` frontmatter.
- `meta/` — cross-project synthesis; a note belongs here if it names ≥2 projects and reasons about them together. Single-project lessons go to `concepts/`.
- `projects/{slug}/` — per-project lifecycle workspace; `proj-*` skills operate here.
- `SCHEMA.md` — vault-wide structural authority.

### Repo Deliverable Layout

npm workspaces monorepo. Skills are prompt-only Markdown; CLI is TypeScript utility code. Both ship from the same repo and are version-locked.

```
llm-wiki/
├── packages/
│   ├── skills/                          # SKILL.md files (prompt-only)
│   │   ├── wiki-init/SKILL.md
│   │   ├── wiki-ingest/SKILL.md
│   │   ├── wiki-query/SKILL.md
│   │   ├── wiki-lint/SKILL.md
│   │   ├── wiki-crystallize/SKILL.md
│   │   ├── wiki-audit/SKILL.md
│   │   ├── proj-init/SKILL.md
│   │   ├── proj-work/SKILL.md
│   │   ├── proj-distill/SKILL.md
│   │   └── proj-decide/SKILL.md
│   ├── cli/                             # TypeScript utility CLI (skillwiki)
│   │   ├── src/
│   │   │   ├── cli.ts                   # Commander entry; single binary
│   │   │   ├── commands/
│   │   │   │   ├── hash.ts              # replaces wiki-hash.sh
│   │   │   │   ├── fetch-guard.ts       # replaces wiki-fetch-guard.sh
│   │   │   │   ├── validate.ts          # frontmatter validation (Zod)
│   │   │   │   ├── graph.ts             # wikilink graph + Adamic-Adar
│   │   │   │   ├── overlap.ts           # source-overlap clusters (E2 4.0× signal)
│   │   │   │   ├── orphans.ts           # orphan + bridge node detection (E3)
│   │   │   │   ├── audit.ts             # citation marker resolution (Citation §)
│   │   │   │   └── install.ts           # cross-platform skills installer
│   │   │   ├── schema/                  # Zod schemas (4 frontmatter shapes)
│   │   │   ├── parsers/                 # YAML, wikilink, footnote-marker parsers
│   │   │   └── utils/                   # canonical paths, hashing, etc.
│   │   ├── test/                        # Vitest specs
│   │   ├── package.json                 # name: "skillwiki", bin: { skillwiki: dist/cli.js }
│   │   ├── tsup.config.ts
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   └── shared/                          # Shared types (used by cli; reserved for future mcp/)
├── templates/
│   ├── SCHEMA.md
│   ├── index.md
│   ├── log.md
│   └── project-README.md
├── package.json                         # workspaces root
├── CLAUDE.md
├── README.md
└── LICENSE
```

The package published to npm is **`skillwiki`** (verified available on npm registry). Skills invoke utilities via `npx skillwiki <subcommand>` or, when globally installed, `skillwiki <subcommand>`. No bash scripts ship in v1.

## Frontmatter Schemas

Four shapes, all additive over Hermes v2.1.0. New fields are silently ignored by Hermes; Hermes-required fields are unchanged.

### Schema 1 — Typed Knowledge (`entities/`, `concepts/`, `comparisons/`, `queries/`)

```yaml
---
title: Page Title
aliases: ["Alt Name"]                                    # Obsidian default (additive)
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [...]
sources: [raw/articles/foo.md]
confidence: high | medium | low                          # optional
contested: true                                          # optional
contradictions: [other-slug]                             # optional
provenance: research | project | mixed                   # NEW
provenance_projects:                                     # NEW (required when provenance != research)
  - "[[cmux]]"
work_items:                                              # NEW optional, traces back to project work
  - "[[2026-04-15-bug]]"
---
```

### Schema 2 — Raw Sources (`raw/`)

```yaml
---
title: "Original Article Title"                          # NEW (separate from filename slug)
source_url: https://example.com/article                  # null when locally originated
ingested: YYYY-MM-DD
ingested_by: wiki-ingest | proj-work | manual            # NEW
sha256: <hex digest of body bytes after closing --->
project: "[[cmux]]"                                      # NEW (project-originated only)
work_item: "[[2026-04-15-bug]]"                          # NEW (project-originated only)
kind: postmortem | session-log | meeting-notes | other   # NEW (project-originated only)
---
```

### Schema 3 — Project Work Items (`projects/{slug}/work/YYYY-MM-DD-{slug}/{spec,plan,log}.md`)

```yaml
---
title: Work item title
aliases: [...]
created: YYYY-MM-DD
updated: YYYY-MM-DD
started: YYYY-MM-DD                                      # distinct from created (file vs work)
completed: YYYY-MM-DD                                    # set when status: completed
kind: feature | issue | refactor | decision
status: planned | in-progress | completed | abandoned
priority: high | medium | low
project: "[[project-slug]]"
owner: "[[person]]"                                      # optional
parent: "[[2026-04-10-other]]"                           # optional, for sub-tasks
related:                                                 # optional
  - "[[2026-04-12-foo]]"
sources: [raw/...]                                       # optional, references during work
---
```

### Schema 4 — Project Compound (`projects/{slug}/compound/`)

```yaml
---
title: Lesson / pattern title
aliases: [...]
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: lesson | pattern | antipattern | gotcha
tags: [...]
confidence: high | medium | low
contradicts: [other-compound-slug]                       # optional
project: "[[project-slug]]"                              # always set; compound is project-local
work_items:                                              # provenance trace
  - "[[2026-04-15-bug]]"
promoted_to: "[[concept-page]]"                          # optional, set by proj-distill
cssclasses: [compound-lesson]                            # optional, Obsidian styling
---
```

### Naming Conventions

- File names: lowercase, hyphens, no spaces (`transformer-architecture.md`).
- Work folders: `YYYY-MM-DD-{slug}/` — sortable and traceable.
- Wikilinks in YAML: quoted strings, `"[[name]]"`. Per kepano/Obsidian official spec.
- Lists of wikilinks: YAML block style preferred for clean diffs.
- Page body wikilinks: standard unquoted `[[name]]` (Hermes/Obsidian convention).

## Citation and Reference Conventions

Citations operate at two complementary layers. The new `provenance:` field is **orthogonal** to citations — it classifies origin for filtering, while `sources:` and inline markers handle per-claim traceability.

### Layer 1 — Page-level metadata (`sources:` frontmatter)
Every typed-knowledge page lists all raw sources it draws from in `sources:`. This is the existing Hermes rule (mandatory). The new `provenance:` field complements it: `sources:` enumerates *artifacts*; `provenance:` classifies *kind of origin* (research/project/mixed).

### Layer 2 — Paragraph-level traceability (inline markers)
When a page synthesizes **3 or more sources**, append a provenance marker at the end of any paragraph whose claims trace to a specific raw file (Hermes rule, SKILL.md lines 97–100):

```markdown
Claude was trained using RLHF, achieving 67% accuracy on benchmark X.
^[raw/articles/anthropic-rlhf-2022.md]
```

Lets a reader verify claims without re-reading raw.

### Internal references
Use Obsidian wikilinks: `[[transformer-architecture]]`. Hermes requires a minimum of 2 outbound wikilinks per page.

### External URLs
- **Preferred**: ingest the URL via `wiki-ingest` first, then cite `^[raw/articles/foo.md]`. Persistent and verifiable.
- **Acceptable for transient references** (not worth a permanent raw entry): `[anchor text](https://example.com/path)`.

### Numbered citations (alternative)
Markdown footnote syntax `[^1]` with a footnote list at page end is acceptable when the page mixes ingested raw sources, external URLs, and wikilinks. Hermes-style `^[raw/...]` is preferred for synthesis-heavy pages because the path is self-documenting.

### Project work-item citation
Inside `projects/{slug}/work/YYYY-MM-DD-{slug}/{spec,plan,log}.md`, the same conventions apply. Sources may be `raw/...` files, vault wikilinks (`[[concepts/foo]]`), or other work items (`[[2026-04-15-other]]`).

### `wiki-audit` enforces consistency
- Every `^[raw/...]` marker must resolve to a real file.
- Every entry in `sources:` must be referenced somewhere in the body (frontmatter ↔ body consistency).
- Bare external URLs in synthesis-heavy pages (3+ sources) trigger a "consider ingesting" suggestion.

### Citation philosophy
Pre-attach, do not retrofit. Citations are added at write time (Hermes `^[raw/...]` markers; the `wiki-ingest` skill writes pages with markers already in place), not bolted on after generation. The page must read as auditable on first commit.

## Skill Inventory

10 skills, two namespaces. Each ships as one `SKILL.md` per directory.

### Knowledge Layer (`wiki-*`) — 6 skills

| Skill | Scope | Key behavior |
|---|---|---|
| `wiki-init` | Bootstrap vault | Scaffold directory tree, ask domain, write SCHEMA/index/log from templates. Single invocation. |
| `wiki-ingest` | URL/file/paste → typed knowledge | Single-pass v1 (E1 2-step deferred to v1.1). Calls `skillwiki fetch-guard` before any URL fetch; computes content hash via `skillwiki hash`; atomic batch apply; low-confidence flag for single-source pages. |
| `wiki-query` | 3-scope search → synthesized answer | Scope selector: vault / current project / project + concepts. **E2: 4-signal relevance ranking** (graph + overlap math via `skillwiki graph build` and `skillwiki overlap`; reasoning-based scoring in prompt). Files substantial answers to `queries/` or `comparisons/`. |
| `wiki-lint` | Health checks | Orphans + bridge nodes via `skillwiki orphans`; broken links + frontmatter validation via `skillwiki validate`; sha256 drift via `skillwiki hash`; **E3: review queue**; tag audit; log rotation. |
| `wiki-crystallize` | Session → typed-knowledge page | Distill working session into a page. Sets `provenance: research` by default; auto-detects project context (cwd inside `projects/{slug}/`) and switches to `provenance: project` with appropriate `provenance_projects:`. |
| `wiki-audit` | Citation verification | Per-page check that every `^[raw/...]` claim resolves; uses `skillwiki audit` to do the deterministic resolution + sources↔body consistency check. Skill reasons over the JSON report. |

### Project Layer (`proj-*`) — 4 skills

| Skill | Scope | Key behavior |
|---|---|---|
| `proj-init` | Bootstrap a project | Create `projects/{slug}/` with README + 4 subfolders (`requirements/`, `architecture/`, `work/`, `compound/`). Register project in vault `index.md`. |
| `proj-work` | Open/run a work item | Override brainstorming/writing-plans default output paths to redirect spec.md and plan.md into `projects/{slug}/work/YYYY-MM-DD-{slug}/`. Manage `kind:` and `status:` lifecycle; log execution to `log.md`. |
| `proj-distill` | Project compound ↔ vault concepts | **E4: 2-step pattern** — analyze project compound entry for universal pattern, then generate vault concept page with `provenance: project`, `provenance_projects: ["[[slug]]"]`. Backlink via `promoted_to:` on the project compound entry. |
| `proj-decide` | Architectural Decision Record (ADR) | Write ADR to `projects/{slug}/architecture/`. If decision generalizes beyond the project, also create a `concepts/` page with `provenance: project` (or `mixed` if research-informed). |

### Cross-Skill Orientation Contract (E5)

Before any operation, every skill reads:
1. Vault `SCHEMA.md` (conventions, taxonomy)
2. Vault `index.md` (existing pages catalog)
3. Recent vault `log.md` (last 20–30 entries)

When running inside a project context (cwd is under `projects/{slug}/...`), additionally read:
4. `projects/{slug}/README.md` (project intent)
5. Recent activity in `projects/{slug}/work/*/log.md` (last ~5 work items)

This is the Hermes orientation pattern extended for project awareness. No `purpose.md` (per Decision 6); README.md carries directional intent.

## Workflow Patterns (E1–E5 from nashsu/llm_wiki study)

All patterns confined to skill prompts; no schema or folder impact.

### E1 — 2-step chain-of-thought ingest (DEFERRED to v1.1)
v1 ships single-pass. v1.1 will refactor `wiki-ingest` into two sequential LLM calls:
- **Step 1 (Analysis)**: produce structured outline of entities, concepts, connections to existing pages, contradictions, suggested page actions. Output is a *review object*.
- **Step 2 (Generation)**: take analysis + user confirmation (or auto-proceed) → write/update pages, index, log.

Documented now so v1.1 implementation is straightforward.

### E2 — Graph-aware retrieval in `wiki-query` (v1)
4-signal relevance ranking using existing frontmatter — no new fields:

| Signal | Weight | Source |
|---|---|---|
| Direct wikilink | 3.0× | `[[wikilinks]]` in body |
| **Source overlap** | 4.0× | Pages sharing entries in `sources:` (free win — already in Hermes schema) |
| Adamic-Adar | 1.5× | Common-neighbor analysis over wikilink graph |
| Type affinity | 1.0× | Same `type:` bonus |

Skill prompt instructs reasoning-based scoring during query synthesis. The deterministic graph math (adjacency, common-neighbor scores, source-overlap clusters) is precomputed by `skillwiki graph build` and `skillwiki overlap` — the skill reads that JSON and reasons over it. No graph DB required at runtime.

### E3 — Review queue in `wiki-lint` (v1)
Lint output adds review section flagging:
- Pages with `confidence: low` AND single `sources:` entry → "promote or corroborate"
- Pages with `contested: true` → "resolve contradiction"
- Orphan clusters (small connected components) → "knowledge gap" — detected by `skillwiki orphans`
- Bridge nodes (uniquely connecting two clusters) → "fragility risk" — detected by `skillwiki orphans`

Each item has a suggested action (`Promote to confidence:medium`, `Run deep-research`, `Archive`, `Review`).

### E4 — 2-step distillation in `proj-distill` (v1)
Architecturally independent of E1 (which is deferred). Pattern:
- **Step 1 (Analyze)**: read project compound entry + linked work items → identify the universal pattern. Output a candidate concept outline.
- **Step 2 (Generate)**: write the vault concept page with appropriate `provenance:`, update both project and vault `index.md` and `log.md`. Set `promoted_to:` backlink on the originating compound entry.

Ships in v1 because the surface area is bounded (one source page → one target page) and the user-confirmation step is explicit by design.

### E5 — Project-aware orientation
See "Cross-Skill Orientation Contract" above.

## Implementation Toolchain

The CLI package (`packages/cli`) ships as the npm package **`skillwiki`**. Skills invoke it as `npx skillwiki <subcommand>` (no global install required) or `skillwiki <subcommand>` when globally installed.

### Toolchain (mirrors atomicmemory/llm-wiki-compiler patterns)

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript ≥ 5.7 | Type-safe; Zod inference |
| Bundler | `tsup` | Fast; single-file ESM+CJS output; tree-shaken |
| CLI framework | `commander` | Battle-tested; same as llmwiki |
| Schema validation | `zod` | Runtime validation aligned with the 4 frontmatter schemas |
| YAML | `js-yaml` | Hermes wire-compat parser |
| Testing | `vitest` | Fast, ESM-native, watch mode |
| Distribution | npm registry as `skillwiki` | Cross-platform; `npx skillwiki@latest` requires no install |
| Runtime | Node.js ≥ 20 | LTS baseline; no native deps in v1 |

### Subcommand Reference

All commands emit JSON by default (parseable by skill prompts), with `--human` for terminal-readable output. Exit code conveys success/failure.

| Subcommand | Purpose | Used by |
|---|---|---|
| `skillwiki hash <file>` | sha256 of body bytes after closing `---` (canonical contract) | `wiki-ingest`, `wiki-lint` |
| `skillwiki fetch-guard <url>` | URL validation: IP blocklist, API-key strip, https-only, size/time limits, fail-closed | `wiki-ingest` |
| `skillwiki validate <file>` | Frontmatter validation against the 4 Zod schemas; reports field-level errors | `wiki-lint`, `wiki-audit` |
| `skillwiki graph build <vault>` | Build wikilink adjacency + Adamic-Adar score table | `wiki-query` (E2), `wiki-lint` |
| `skillwiki overlap <vault>` | Source-overlap clusters (E2 4.0× signal) | `wiki-query` |
| `skillwiki orphans <vault>` | Orphan pages + bridge node detection | `wiki-lint` (E3) |
| `skillwiki audit <file>` | `^[raw/...]` resolution + sources↔body consistency | `wiki-audit` |
| `skillwiki install` | Cross-platform skills installer; preflight, atomic copy, manifest at `.claude/skills/wiki-manifest.json` | one-shot setup |

### Cross-Platform Commitment

- Linux, macOS, Windows: all rely on Node ≥ 20 only — eliminates bash-on-Windows pain.
- No native deps in v1 (no `pdf-parse`, no `jsdom`) — keeps install fast and portable.
- `skillwiki install` (Node) replaces what would have been `install.sh` (bash).

### Prompt-Only Boundary

The CLI does **deterministic data work only**. It does not call LLMs. All reasoning — page generation, contradiction detection, distillation — remains in the skill prompts. This preserves the prompt-only philosophy and avoids duplicating LLM logic across two implementations.

### Future MCP Server (v1.2+)

The `packages/shared/` directory exists from day one to hold types reused between `cli/` and a future `mcp/` package. An MCP server would expose the same subcommand functions to non-Claude-Code agents (Codex, Cursor) without re-implementing logic.

## Security Model (v1 Boundaries)

Two enforcement layers, plus declared non-goals. The split is normative: a control belongs to exactly one layer. This section is the authoritative source for security behavior — the Codex Adversarial Review F1 entry below is an audit trail, not a definition.

### Layer 1 — URL/network preflight (`skillwiki fetch-guard`)

Runs before any network I/O. Pure validation; no fetch is performed by the guard itself.

- **Allowed schemes**: `https` only.
- **Blocked host classes**: RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local (169.254.0.0/16, fe80::/10), loopback (127.0.0.0/8, ::1), and known cloud metadata endpoints (169.254.169.254, metadata.google.internal).
- **Credential stripping**: query-parameter tokens (`api_key`, `token`, `key`, `auth`, `password`, `secret`) and path-embedded tokens **MUST** be redacted from any logged form of the URL.
- **Malformed URL behavior**: reject with non-zero exit; do not attempt repair, normalization, or fallback.
- **Output**: JSON `{ allowed: bool, reason?: string, sanitized_url: string }` with exit code 0 (allow) or non-zero per the Command Contracts table.

### Layer 2 — Fetch execution controls (`wiki-ingest` flow)

Applied during the actual fetch, after `fetch-guard` clears.

- **Request timeout**: 30 seconds; abort and fail closed on exceeded.
- **Max byte limit**: 5 MB; abort and fail closed on exceeded.
- **Redirect policy**: follow up to 5 redirects. Each redirect target **MUST** be re-validated by `fetch-guard` before being followed.
- **Failure mode**: any error during fetch **MUST** stop ingest before any file is written. Partial state is not permitted.

### Threat assumptions and non-goals (v1)

v1 protects against accidental SSRF to internal/metadata services and against credential leakage in command logs. v1 does **NOT** protect against:

- Malicious content within fetched pages (no HTML/JS sandboxing).
- Supply-chain compromise of npm dependencies.
- Compromise of the host Claude Code environment.
- Time-of-check / time-of-use races between guard validation and fetch (mitigated by re-validating redirect targets, not eliminated).

## Command Contracts

Every subcommand: required inputs, output JSON shape, exit codes, determinism, and side effects. JSON is the default output; `--human` switches to terminal-readable text without changing exit codes (per N2).

Exit codes are stable across the v1 line. New failure classes in v1.x **MUST** use unused codes; existing codes **MUST NOT** be reassigned.

### `skillwiki hash <file>`

- **Input**: path to a Markdown file with frontmatter.
- **Output**: `{ path, sha256, byte_count }`.
- **Exit codes**: 0 success; 2 file not found; 3 missing closing `---`.
- **Determinism**: pure function of file body bytes; read-only.
- **Side effects**: none.

### `skillwiki fetch-guard <url>`

- **Input**: a single URL string.
- **Output**: `{ allowed, reason?, sanitized_url }`.
- **Exit codes**: 0 allowed; 4 scheme rejected; 5 host blocked; 6 malformed URL.
- **Determinism**: pure validation; no network I/O.
- **Side effects**: none.

### `skillwiki validate <file>`

- **Input**: path to a Markdown file.
- **Output**: `{ schema, valid, errors: [{ path, message }] }`.
- **Exit codes**: 0 valid; 7 invalid frontmatter; 8 schema not detected.
- **Determinism**: pure (file read + Zod parse).
- **Side effects**: none.

### `skillwiki graph build <vault>`

- **Input**: vault root path; optional `--out <path>` (default `.skillwiki/graph.json`).
- **Output**: writes adjacency + Adamic-Adar score table to `--out`; stdout JSON has `{ out_path, node_count, edge_count }`.
- **Exit codes**: 0 success; 9 vault path invalid; 10 write failed.
- **Determinism**: deterministic for a fixed vault snapshot.
- **Side effects**: writes one file at `--out`. Idempotent overwrite.

### `skillwiki overlap <vault>`

- **Input**: vault root path.
- **Output**: `{ clusters: [{ id, members: [paths], score }] }`.
- **Exit codes**: 0 success; 9 vault path invalid.
- **Determinism**: deterministic.
- **Side effects**: none.

### `skillwiki orphans <vault>`

- **Input**: vault root path.
- **Output**: `{ orphans: [paths], bridges: [{ path, connects: [cluster_ids] }] }`.
- **Exit codes**: 0 success; 9 vault path invalid.
- **Determinism**: deterministic.
- **Side effects**: none.

### `skillwiki audit <file>`

- **Input**: path to a typed-knowledge Markdown file.
- **Output**: `{ markers: [{ marker, target, resolved }], sources_consistency: { unused_sources, missing_from_sources } }`.
- **Exit codes**: 0 audit clean; 11 unresolved markers; 12 sources/body inconsistency.
- **Determinism**: pure (file read + path resolution).
- **Side effects**: none.

### `skillwiki install`

- **Input**: optional `--target <dir>` (default `~/.claude/skills/`); optional `--dry-run`.
- **Output**: `{ installed: [paths], backed_up: [paths], manifest_path }`.
- **Exit codes**: 0 success; 13 preflight failed; 14 atomic copy failed.
- **Determinism**: depends on filesystem state; idempotent (a re-run on identical state yields the same manifest).
- **Side effects**: writes skill files; writes `.claude/skills/wiki-manifest.json`; writes `.bak` files for any overwritten existing skills (per N18).

## Skill Execution Contracts

Every skill is a prompt-only Markdown file. To compensate for prompt-level non-determinism, each skill has a normative execution contract: which deterministic commands it MUST run, in which order writes MUST be applied, and which conditions MUST stop execution rather than partial-apply.

### Pre-orientation reads (every skill, always)

1. Vault `SCHEMA.md`
2. Vault `index.md`
3. Last 20–30 entries of vault `log.md`
4. (Project context only — cwd inside `projects/{slug}/...`) `projects/{slug}/README.md` and the last ~5 work-item logs

A skill **MUST NOT** mutate any file before completing the orientation reads applicable to its context.

### `wiki-init`

- **Commands**: none (pure scaffolding from templates).
- **Write order**: directory tree → `SCHEMA.md` → `index.md` → `log.md`.
- **Stop conditions**: target directory non-empty; vault already initialized.

### `wiki-ingest`

- **Commands (in order, per source)**: `fetch-guard` → fetch → `hash` → `validate` (per generated page).
- **Write order**: raw file → typed-knowledge page(s) → `index.md` → `log.md`.
- **Stop conditions**: `fetch-guard` non-zero; fetch timeout / byte-limit exceeded; `validate` non-zero on any generated page; sha256 collision with an existing raw file (treated as duplicate; ingest skips).
- **Log update**: one `log.md` entry per ingested URL or file, recording sha256 and resulting page slugs.

### `wiki-query`

- **Commands (in order)**: `graph build` (if `.skillwiki/graph.json` is missing or stale) → `overlap`.
- **Write order**: read-only unless a synthesis is filed; if filed: page → `index.md` → `log.md`.
- **Stop conditions**: zero matching pages; user declines to file synthesis.
- **Log update**: one `log.md` entry only when a `queries/` or `comparisons/` page is filed.

### `wiki-lint`

- **Commands (in order)**: `validate` (per page) → `hash` (per raw file) → `orphans`.
- **Write order**: read-only by default. May rewrite `log.md` for rotation only.
- **Stop conditions**: none — lint reports all findings even when individual checks fail.
- **Log update**: one `log.md` entry per lint run with summary counts.

### `wiki-crystallize`

- **Commands**: `validate` on the new page.
- **Write order**: page → `index.md` → `log.md`.
- **Stop conditions**: `validate` non-zero; missing required `provenance:` for project-context runs.
- **Log update**: one `log.md` entry per crystallized page.

### `wiki-audit`

- **Commands**: `audit` (per page).
- **Write order**: read-only; emits report.
- **Stop conditions**: none — reports all findings.
- **Log update**: one `log.md` entry per audit run.

### `proj-init`

- **Commands**: none.
- **Write order**: project tree → `projects/{slug}/README.md` → vault `index.md` → vault `log.md`.
- **Stop conditions**: `projects/{slug}/` already exists.

### `proj-work`

- **Commands**: `validate` on work-item frontmatter.
- **Write order**: work folder → `spec.md` → `plan.md` → work `log.md` → vault `log.md`.
- **Stop conditions**: `validate` non-zero on frontmatter; conflicting work folder name.
- **Log update**: vault `log.md` entry on creation and on each `status:` transition.

### `proj-distill`

- **Commands**: `validate` on the candidate concept page.
- **Write order**: vault concept page → backlink update on the source project compound entry (`promoted_to:`) → project `log.md` → vault `index.md` → vault `log.md`.
- **Stop conditions**: `validate` non-zero; no clear universal pattern (skill aborts and surfaces its reasoning instead of forcing a page).
- **Log update**: one entry per distillation in both project and vault logs.

### `proj-decide`

- **Commands**: `validate` on the ADR and (if generated) on the concept page.
- **Write order**: ADR → (optional) concept page → vault `index.md` → vault `log.md` and project `log.md`.
- **Stop conditions**: `validate` non-zero on either page.
- **Log update**: one entry per ADR.

## Codex Adversarial Review

### F1: Security control parity → `skillwiki fetch-guard`
Authoritative behavior is defined in the **Security Model (v1 Boundaries)** section above. F1 is satisfied by the combination of Layer 1 (preflight: blocked-host classes, scheme enforcement, credential stripping, malformed-URL rejection) and Layer 2 (fetch execution: 5 MB byte limit, 30 s timeout, redirect re-validation, fail-closed). Implemented as TypeScript with Zod URL validation; invoked before every `web_fetch` in `wiki-ingest`.

### F2: Non-atomic ingest → staged batch apply
Collect all writes, verify, apply pages → index → log in order. Re-run safe via sha256 dedup (`skillwiki hash`). Prompt-only enforcement; relies on idempotency for recovery.

### F3: Hash contract → `skillwiki hash`
sha256 of body bytes after closing `---`, no normalization. Implemented with Node's `crypto.createHash('sha256')`. Lint recomputes and flags mismatches without auto-update. Re-ingest skips on identical hash, flags drift on change. Identical canonical contract to v1 spec — language change only.

### F4: Installer safety → `skillwiki install`
Preflight target dirs, back up existing skills, atomic file copy, manifest at `.claude/skills/wiki-manifest.json` for clean uninstall. Cross-platform: works identically on Linux, macOS, Windows.

### F5: Folder conflict (Medium) — Not Applicable
Repo is standalone, not nested in vault.

## Hermes Wire-Compatibility Guarantee

A vault produced by this skill remains fully maintainable by Hermes llm-wiki v2.1.0 without migration.

**Preserved exactly from Hermes:**
- Directory layout (raw/, entities/, concepts/, comparisons/, queries/)
- Required frontmatter fields (title, created, updated, type, tags, sources)
- Optional Hermes fields (confidence, contested, contradictions)
- SCHEMA.md / index.md / log.md formats
- `[[wikilink]]` body convention
- Raw immutability + sha256 drift contract

**Additive (Hermes ignores silently):**
- New folders: `meta/`, `projects/`
- New frontmatter fields: `provenance`, `provenance_projects`, `work_items`, `aliases`, `priority`, `owner`, `started`, `completed`, `parent`, `kind`, `status`, `project`, `ingested_by`, `promoted_to`, `cssclasses`, `contradicts`
- Wikilink-as-quoted-string YAML format

The skill adds capability Hermes lacks (project lifecycle, distillation, graph-aware query) without modifying anything Hermes parses. Hermes will not *use* the project layer, but nothing breaks.

## Migration Policy

v1 does **not** migrate existing `5️⃣-Projects/Research/` content. Existing notes are reference material for design validation only.

Post-implementation (out of v1 scope):
1. Audit existing notes against new schemas
2. Identify research-origin notes for `entities/concepts/...` (with `provenance: research`)
3. Identify project-archive candidates for `projects/*/work/`
4. Manual or scripted migration

## Definition of Done (v1)

v1 ships only when every item below is true. Each item is a single objective check. This list is the sole acceptance gate; passing every check ends v1 implementation.

- [ ] All 10 `SKILL.md` files exist under `packages/skills/` and parse as valid Markdown with the required frontmatter envelope.
- [ ] `packages/cli` builds with `tsup` and produces a runnable `skillwiki` binary on Node ≥ 20.
- [ ] All 8 subcommands return the documented JSON shape and exit codes for a fixture set covering every error class declared in Command Contracts.
- [ ] Vitest suite is green; for each of the 4 Zod schemas the suite includes at least one passing fixture and one failing fixture per required field.
- [ ] `skillwiki fetch-guard` test suite covers, at minimum: each blocked host class, scheme rejection, credential stripping (query-param and path-embedded), malformed-URL rejection, and redirect re-validation.
- [ ] `skillwiki install` smoke test (including `--dry-run`) passes on Linux, macOS, and Windows in CI.
- [ ] Hermes wire-compatibility integration test: a vault produced by `wiki-init` plus one `wiki-ingest` run validates under the Hermes v2.1.0 schema with no errors.
- [ ] `templates/` contains `SCHEMA.md`, `index.md`, `log.md`, and `project-README.md`, each referenced by `wiki-init` or `proj-init`.
- [ ] Repo `README.md` and `CLAUDE.md` reference `skillwiki` only — no stale `install.sh` or bash-script mentions remain.
- [ ] No bash scripts exist anywhere in the repo (verified by repo grep).
- [ ] Every Normative Requirement N1–N18 has at least one corresponding test or verification step in the suite.

## Roadmap

### v1 (this spec)
Vault structure + 10 SKILL.md + `skillwiki` npm package (8 subcommands) + cross-platform installer + templates. Hermes-compat baseline.

### v1.1
- E1: 2-step chain-of-thought ingest as default
- Auto-mirror frontmatter enums to nested tags (`#provenance/project/cmux`, `#kind/feature`, etc.) — implemented as `skillwiki tag-sync` subcommand + lint hook
- Starter Bases views (`views/`) for graph insights, work-by-project, contested pages, source-overlap clustering
- `purpose.md` directional intent layer (vault root + per-project)

### v1.2+
- Multi-format ingest (PDF/DOCX/PPTX) via `skillwiki extract` (likely uses `pdf-parse`, `jsdom`/`turndown`)
- Vector search (LanceDB) optional integration
- **MCP server** (`packages/mcp`) exposing the same subcommand functions to non-Claude-Code agents (Codex, Cursor)
- Cross-vault federation
- Migration tooling for existing Obsidian content

## Sources

- Hermes Agent llm-wiki SKILL.md v2.1.0 (`raw/hermes-llm-wiki-SKILL-v2.1.0.md`) — vault format, frontmatter contract, ingest/query/lint operations, inline citation rules
- nashsu/llm_wiki research note (`/Users/karlchow/Documents/obsidian_vault/5️⃣-Projects/Research/2026-05-03-nashsu-llm-wiki-desktop-app-deep-research.md`) — 2-step ingest, 4-signal graph, async review patterns
- **atomicmemory/llm-wiki-compiler** (`https://github.com/atomicmemory/llm-wiki-compiler`) — toolchain reference for the `skillwiki` CLI: TypeScript + tsup + Vitest + Commander + Zod + js-yaml + npm `bin` pattern, src/ module layout (commands/, schema/, parsers/, utils/), npx-friendly distribution
- kepano/obsidian-skills `obsidian-markdown/references/PROPERTIES.md` — Obsidian YAML conventions, wikilink-as-quoted-string format
- CodeStable framework (6-entity architecture) — inspiration for project layer (no code dependency)
- kfchou/wiki-skills, vanillaflava/llm-wiki-claude-skills, claude-wiki-verbs — wiki-skill ecosystem references
- npm + Homebrew package-name availability check (2026-05-03) — `skillwiki` confirmed free; `codewiki`, `llm-wiki`, `skillforge`, `skilldoc`, `llmdoc`, `wikidot` taken
- Codex adversarial review (2026-05-02) — 4 high-severity findings preserved as F1–F4 (now backed by `skillwiki` subcommands)
