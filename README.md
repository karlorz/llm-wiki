# CodeWiki / skillwiki

Project-aware Karpathy-style knowledge base for Claude Code skills.

## Install

### Option A — Claude Code plugin (recommended)

```text
/plugin marketplace add karlorz/llm-wiki
/plugin install skillwiki@llm-wiki
```

The plugin ships 18 skills (`wiki-*`, `proj-*`, `wiki-add-task`, `wiki-adapter-prd`, `wiki-reingest`, `using-skillwiki`). They are namespaced by Claude Code as `llm-wiki:<skill>` (e.g. `llm-wiki:wiki-init`).

### Option B — npm CLI installer

```bash
npx skillwiki@latest install
```

This copies 18 SKILL.md files into `~/.claude/skills/` and writes `.claude/skills/wiki-manifest.json`. Use this when you want the skills available outside a Claude Code plugin context, or to seed `~/.claude/skills/` for tools that scan it directly.

### Option C — Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/karlorz/llm-wiki
```

The repository root includes an `agy`-compatible `plugin.json` plus a matching `.claude-plugin/plugin.json` marker for GitHub URL installs. Root `skills/` and `agents/` are materialized mirrors of the canonical files under `packages/skills/`. Local validation should report 18 processed skills and 16 processed agents:

```bash
agy plugin validate .
```

## Skills

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit`, `wiki-archive`, `wiki-reingest`, `wiki-adapter-prd`, `wiki-add-task`, `wiki-sync`, `wiki-canvas`, `wiki-gate-plan-mode` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |
| onboarding | `using-skillwiki` |

## CLI

`skillwiki` exposes 36 deterministic subcommands consumed by the skills:

| Subcommand | Purpose |
|---|---|
| `init <vault>` | Bootstrap vault with SCHEMA.md, index.md, log.md. |
| `install` | Cross-platform skills installer (copies or symlinks SKILL.md files). |
| `hash <file>` | sha256 of body bytes after closing `---`. |
| `validate <file>` | Frontmatter Zod validation. |
| `lint <vault>` | Vault health check (stale pages, dedup, taxonomy, citations, sources). |
| `audit <file>` | Citation marker + sources↔body consistency. |
| `fetch-guard <url>` | URL preflight (Layer 1 security). |
| `graph build <vault>` | Wikilink adjacency + Adamic-Adar table. |
| `overlap <vault>` | Source-overlap clusters. |
| `orphans <vault>` | Orphan + bridge node detection. |
| `drift <vault>` | Detect raw source drift via sha256 comparison. |
| `dedup <vault>` | Detect duplicate raw articles. |
| `archive <page>` | Move superseded typed-knowledge page to `_archive/`. |
| `config` | Manage skillwiki configuration and wiki profiles. |
| `doctor` | Diagnose setup issues (paths, env, plugin, sync health). |
| `path` | Resolve vault or project paths. |
| `lang` | Detect vault language from SCHEMA.md. |
| `pagesize <vault>` | Report page sizes, flag oversized pages. |
| `stale <vault>` | List stale transcripts and incomplete work items. |
| `links <vault>` | Wikilink graph analysis. |
| `log-rotate <vault>` | Rotate log.md when it exceeds size limit. |
| `migrate-citations <vault>` | Convert legacy citation markers to current format. |
| `frontmatter-fix <vault>` | Auto-fix common frontmatter issues. |
| `tag-audit <vault>` | Audit tag taxonomy compliance. |
| `tag-sync <vault>` | Mirror frontmatter enum values to nested Obsidian tags. |
| `topic-map-check <vault>` | Validate topic map consistency. |
| `index-check <vault>` | Validate index.md entries. |
| `index-link-format <vault>` | Fix index link format issues. |
| `project-index <slug>` | Build project workspace knowledge index. |
| `compound promote` | Promote retros to compound entries. |
| `compound list` | List compound entries for a project. |
| `sync status` | Check vault git sync status. |
| `seed <vault>` | Populate a new vault with example content. |
| `observe <vault>` | Create raw transcript observation entry. |
| `canvas generate` | Generate Obsidian Canvas from graph.json. |
| `transcripts <vault>` | Scan raw/transcripts for new ad-hoc captures. |
| `update` | Check for skillwiki updates. |

All subcommands emit JSON by default. Pass `--human` for terminal output.

## Development

```bash
npm install
npm run -w @skillwiki/shared test
npm run -w skillwiki build
npm run -w skillwiki test
```

Requires Node ≥ 20.

## Spec

The canonical specification lives at `~/wiki/projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md` (revised 2026-05-03).
