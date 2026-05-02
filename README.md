# CodeWiki / skillwiki

Project-aware Karpathy-style knowledge base for Claude Code skills.

## Install

```bash
npx skillwiki@latest install
```

This copies 10 SKILL.md files into `~/.claude/skills/` and writes `.claude/skills/wiki-manifest.json`.

## Skills

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |

## CLI

`skillwiki` exposes 8 deterministic subcommands consumed by the skills:

| Subcommand | Purpose |
|---|---|
| `hash <file>` | sha256 of body bytes after closing `---`. |
| `fetch-guard <url>` | URL preflight (Layer 1 security). |
| `validate <file>` | Frontmatter Zod validation. |
| `graph build <vault>` | Wikilink adjacency + Adamic-Adar table. |
| `overlap <vault>` | Source-overlap clusters. |
| `orphans <vault>` | Orphan + bridge node detection. |
| `audit <file>` | Citation marker + sources↔body consistency. |
| `install` | Cross-platform skills installer. |

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

The canonical specification lives at `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md` (revised 2026-05-03).
