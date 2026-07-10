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

After changing canonical skill, agent, or hook assets under `packages/skills/`,
regenerate install-facing mirrors before validating:

```bash
npm run materialize:plugins
npm run materialize:plugins:check
```

## Skills

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit`, `wiki-archive`, `wiki-reingest`, `wiki-adapter-prd`, `wiki-add-task`, `wiki-sync`, `wiki-canvas`, `wiki-gate-plan-mode` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |
| onboarding | `using-skillwiki` |

A sibling `vault-sync` plugin ships six operational skills (install, status, presync, snapshot, FUSE freshness, uninstall). It is packaged separately from the skillwiki skill set.

## CLI

`skillwiki` exposes a deterministic CLI consumed by the skills. Prefer the built
help over hard-coded counts:

```bash
npm run -w packages/cli build
node packages/cli/dist/cli.js --help
```

As of package version `0.9.56`, the built CLI advertises 47 public top-level
subcommands plus `help` (48 including `help`). Nested groups include `graph`,
`canvas`, `compound`, `config`, `sync`, `backup`, `memory`, and `fleet`.

| Subcommand | Purpose |
|---|---|
| `init` | Bootstrap vault with SCHEMA.md, index.md, log.md. |
| `install` | Cross-platform skills installer (copies or symlinks SKILL.md files). |
| `hash <file>` | sha256 of body bytes after closing `---`. |
| `validate <file>` | Frontmatter Zod validation. |
| `lint <vault>` | Vault health check (stale pages, dedup, taxonomy, citations, sources). |
| `health <vault>` | Bounded whole-system wiki health report. |
| `status <vault>` | Vault diagnostics. |
| `audit <file>` | Citation marker + sources↔body consistency. |
| `fetch-guard <url>` | URL preflight (Layer 1 security). |
| `query <text>` | Score and rank vault pages by relevance. |
| `graph` | Wikilink adjacency + Adamic-Adar table. |
| `overlap <vault>` | Source-overlap clusters. |
| `orphans <vault>` | Orphan + bridge node detection. |
| `drift <vault>` | Detect raw source drift via sha256 comparison. |
| `dedup <vault>` | Detect duplicate raw articles. |
| `archive <page>` | Move superseded typed-knowledge page to `_archive/`. |
| `claim <transcript>` | Claim an unclaimed transcript by creating a work item. |
| `config` | Manage skillwiki configuration and wiki profiles. |
| `doctor` | Diagnose setup issues (paths, env, plugin, sync health). |
| `path` | Resolve vault or project paths. |
| `lang` | Detect vault language from SCHEMA.md. |
| `pagesize <vault>` | Report page sizes, flag oversized pages. |
| `stale <vault>` | List stale transcripts and incomplete work items. |
| `links <vault>` | Wikilink graph analysis. |
| `log-rotate <vault>` | Rotate log.md when it exceeds size limit. |
| `log-append <vault>` | Append a vault log entry under an advisory lock. |
| `migrate-citations <vault>` | Convert legacy citation markers to current format. |
| `frontmatter-fix <vault>` | Auto-fix common frontmatter issues. |
| `tag-audit <vault>` | Audit tag taxonomy compliance. |
| `tag-sync <vault>` | Mirror frontmatter enum values to nested Obsidian tags. |
| `topic-map-check <vault>` | Validate topic map consistency. |
| `index-check <vault>` | Validate index.md entries. |
| `index-link-format <vault>` | Fix index link format issues. |
| `project-index <slug>` | Build project workspace knowledge index. |
| `compound` | Promote retros and list compound entries. |
| `sync` | Vault git sync helpers. |
| `backup` | S3-compatible remote backup sync/restore. |
| `seed <vault>` | Populate a new vault with example content. |
| `observe <vault>` | Create raw transcript observation entry. |
| `session-brief <vault>` | Render or refresh the bounded startup session brief. |
| `memory` | Inspect derived agent memory caches. |
| `ingest <source>` | Ingest a URL or local file into the vault. |
| `fleet` | Fleet topology validate/context/health. |
| `canvas` | Generate and manage Obsidian Canvas files. |
| `transcripts <vault>` | Scan raw/transcripts for new ad-hoc captures. |
| `update` | Check for skillwiki updates from npm. |
| `self-update` | Update skillwiki CLI from local source or npm dist-tag. |
| `mcp` | Local experimental MCP server entry (unsupported; see below). |

All subcommands emit JSON by default. Pass `--human` for terminal output.

## MCP Server (experimental, hidden)

> **Status:** shelved. The MCP surface is **not advertised** and **not bundled** in the plugins. It will be revisited once the brain moves to a real remote, centrally-managed wiki. Code remains under `packages/cli/src/mcp/` and `skillwiki mcp` / `skillwiki-mcp` for local experiments; no docs, no manifest declaration, no support.

## Development

```bash
npm install
npm run materialize:plugins:check
npm run -w @skillwiki/shared test
npm run -w skillwiki build
npm run -w skillwiki test
```

Requires Node ≥ 20.

## Spec

The archive-only canonical specification lives under the active SkillWiki vault at
`{WIKI_PATH}/projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md`
(revised 2026-05-03). Resolve `{WIKI_PATH}` with `skillwiki path`.
