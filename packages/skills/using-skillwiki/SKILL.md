---
name: using-skillwiki
description: Invoke at session start or when knowledge-base tasks arise — maps all wiki-*/proj-* skills and teaches the skillwiki CLI workflow
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
- Wants to archive or clean up old vault pages
- Needs to detect source drift or re-ingest updated content
- Has a spec/plan in a non-skillwiki format (CodeStable, RFC, AIDE)
- Asks about their skillwiki configuration or setup health

## Vault Structure

A skillwiki vault has two layers:

**Layer 1 — Raw (`raw/`):** Immutable source material. Never modify after ingest.

```
raw/
├── articles/    # Web articles, clippings
├── papers/      # PDFs, arxiv papers
├── transcripts/ # Meeting notes, interviews
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

**Layer 2 — Agent-owned pages:** `entities/`, `concepts/`, `comparisons/`, `queries/`, `meta/`, `projects/`. Citations use `^[raw/articles/source-file.md]` markers at paragraph-end.

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
| `wiki-adapter-prd` | Map foreign PRD formats (CodeStable, RFC, AIDE, Hermes) into vault pages |
| `proj-init` | Bootstrap a project workspace (README, requirements, architecture) |
| `proj-work` | Open or run a work item under a project's work/ directory |
| `proj-distill` | Distill project compound entries into vault concept pages |
| `proj-decide` | Write an Architectural Decision Record (ADR) |

## CLI Backbone

All skills are backed by the `skillwiki` CLI — a deterministic tool with no LLM calls. It handles path resolution, config management, validation, and linting. Skills invoke it via Bash for the mechanical parts and use Claude for the creative parts.

Key CLI subcommands: `init`, `lint`, `config`, `doctor`, `path`, `lang`, `install`, `graph build`, `archive`, `drift`.

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
