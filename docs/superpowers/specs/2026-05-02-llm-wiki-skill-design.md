# LLM Wiki Skill — Design Specification

**Date**: 2026-05-02
**Status**: Draft
**Repo**: `/Users/karlchow/Desktop/code/llm-wiki`

## TL;DR

A multi-skill Claude Code plugin that builds and maintains Karpathy-style interlinked markdown knowledge bases. The wiki vault output is wire-compatible with Hermes Agent's built-in `llm-wiki` skill (v2.1.0) so either skill can maintain the same wiki.

Primary base: kfchou/wiki-skills (HIGH Hermes compat). Hybrid enhancements ported from vanillaflava (crystallize, reliability scoring), claude-wiki-verbs (installer, 4-tier search), llm-wiki-compiler (hash-based drift detection), and kfchou (citation audit).

## Design Decisions

1. **Hermes wire-compat first** — vault format (directory structure, frontmatter, index, log, raw) must be parseable by Hermes llm-wiki v2.1.0 without migration
2. **Multi-skill split** — 6 focused skills (init, ingest, query, lint, crystallize, audit) rather than one monolithic SKILL.md
3. **Hermes field names** — use `type` not `page_type`, `confidence` not `reliability`, `sources` not `source`, `SCHEMA.md` not `wiki-schema.md`
4. **Selective scripting** — two helper scripts for enforceable correctness (hash contract, fetch security) while keeping the rest prompt-only
5. **Claude Code only** — initial target is Claude Code skills; cross-platform install deferred

## Repo Structure

```
llm-wiki/
├── skills/
│   ├── wiki-init/SKILL.md          # Initialize a new wiki vault
│   ├── wiki-ingest/SKILL.md        # URL/file/paste → raw → wiki pages
│   ├── wiki-query/SKILL.md         # Question → synthesis from compiled wiki
│   ├── wiki-lint/SKILL.md          # Health check: orphans, broken links, drift
│   ├── wiki-crystallize/SKILL.md   # Session → wiki page (from vanillaflava)
│   └── wiki-audit/SKILL.md         # Citation verification (from kfchou)
├── scripts/
│   ├── wiki-hash.sh                # Canonical sha256 for raw source drift detection
│   └── wiki-fetch-guard.sh         # Security wrapper for URL ingestion
├── templates/
│   ├── SCHEMA.md                   # Hermes-compatible schema template
│   ├── index.md                    # Hermes-compatible index template
│   └── log.md                      # Hermes-compatible log template
├── install.sh                      # Claude Code skill installer
├── CLAUDE.md                       # Repo instructions for Claude Code
├── README.md                       # Usage docs
└── LICENSE                         # MIT
```

## Wiki Vault Output (Hermes-Compatible)

```
wiki/
├── SCHEMA.md           # Conventions, tag taxonomy, domain config
├── index.md            # Sectioned content catalog
├── log.md              # Chronological action log (append-only, rotated at 500 entries)
├── raw/                # Layer 1: Immutable source material
│   ├── articles/       # Web articles, clippings
│   ├── papers/         # PDFs, arxiv papers
│   ├── transcripts/    # Meeting notes, interviews
│   └── assets/         # Images, diagrams
├── entities/           # Layer 2: Entity pages (people, orgs, products, models)
├── concepts/           # Layer 2: Concept/topic pages
├── comparisons/        # Layer 2: Side-by-side analyses
└── queries/            # Layer 2: Filed query results
```

### Page Frontmatter (Hermes field names)

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from SCHEMA taxonomy]
sources: [raw/articles/source-name.md]
confidence: high | medium | low      # optional
contested: true                      # optional
contradictions: [page-slug]          # optional
---
```

### Raw Source Frontmatter

```yaml
---
source_url: https://example.com/article
ingested: YYYY-MM-DD
sha256: <hex digest of body content below frontmatter>
---
```

### Index Format

Sectioned by type (Entities, Concepts, Comparisons, Queries). Each entry: wikilink + one-line summary. Header with last-updated date and total page count.

### Log Format

Append-only. `## [YYYY-MM-DD] action | subject`. Actions: ingest, update, query, lint, create, archive, delete. Rotate at 500 entries.

## Skill Decomposition

### wiki-init
- Source: Hermes init flow (SKILL.md lines 96-252)
- Creates wiki directory structure, SCHEMA.md (customized to domain), index.md, log.md
- Session: single invocation

### wiki-ingest
- Source: Hermes ingest flow (SKILL.md lines 256-300) + vanillaflava reliability scoring
- Steps: fetch-guard check → raw capture with sha256 → discuss takeaways → check existing pages → write/update wiki pages → update index + log
- Enhancement from vanillaflava: `## Pending Review` section auto-added for single low-confidence sources
- Atomicity: staged batch apply (collect all writes, apply pages → index → log, idempotent re-run via sha256 dedup)
- Quality: `confidence: low` set by default for single-source pages; `confidence: high` only when well-supported across multiple sources

### wiki-query
- Source: Hermes query flow (SKILL.md lines 302-315) + claude-wiki-verbs 4-tier search
- Search chain: Wiki index → File grep (raw/) → External web search
- Files valuable answers to queries/ or comparisons/ (only substantial ones)

### wiki-lint
- Source: Hermes lint flow (SKILL.md lines 317-365)
- Checks: orphan pages, broken wikilinks, index completeness, frontmatter validation, stale content, contradictions, quality signals, source drift, page size, tag audit, log rotation
- Enhancement: sha256 drift detection via `scripts/wiki-hash.sh` with canonical contract
- Severity order: broken links > orphans > source drift > contested pages > stale content > style issues

### wiki-crystallize
- Source: vanillaflava/llm-wiki-claude-skills (not in Hermes)
- Distills working session knowledge into a wiki page
- Adds `crystallize_count` as a comment in the page body (not frontmatter — would break Hermes compat)
- Use case: end-of-session compounding — capture insights from the conversation into persistent wiki

### wiki-audit
- Source: kfchou/wiki-skills (not in Hermes)
- Per-page citation verification: checks every source claim against actual raw content
- Flags uncited claims and cited-but-not-found sources
- Produces audit report

## Codex Finding Fixes

### F1: Security Control Parity (High)
- **Script**: `scripts/wiki-fetch-guard.sh`
- **Checks**: private/metadata IP blocklist, API key stripping from URLs, https-only scheme, 5MB byte limit, 30s timeout, fail-closed
- **Integration**: wiki-ingest skill runs this before any `web_fetch` call

### F2: Non-Atomic Ingest (High)
- **Pattern**: staged batch apply in wiki-ingest prompt
- **Mechanism**: collect all page creates/updates, verify feasibility, apply pages → index → log in order
- **Recovery**: re-running ingest is safe (sha256 dedup skips already-processed sources)
- **Limitation**: prompt-only skill cannot enforce true transactional semantics; relies on idempotency for recovery

### F3: Hash Contract (High)
- **Script**: `scripts/wiki-hash.sh`
- **Contract**: sha256 of file content after closing `---` of frontmatter, exact bytes, no normalization
- **On lint**: recompute using same script, compare byte-for-byte, flag mismatches in report, do NOT auto-update
- **On re-ingest**: compute hash, compare to stored value, skip if identical, flag drift if changed

### F4: Installer Safety (High)
- **Script**: `install.sh` (Claude Code only)
- **Behavior**: preflight check target dirs, back up existing skills, copy each skill file atomically, generate manifest for uninstall
- **Manifest**: `.claude/skills/wiki-manifest.json` tracks installed files for clean removal

### F5: Folder Conflict (Medium) — Not Applicable
- This repo is standalone, not inside the Obsidian vault
- The `raw/` submodule conflict from Codex review does not apply

## Compatibility Guarantee

A wiki vault produced by this skill must be maintainable by Hermes llm-wiki v2.1.0 without migration. Specifically:

- Same directory structure (raw/, entities/, concepts/, comparisons/, queries/)
- Same frontmatter field names and value enums
- Same SCHEMA.md, index.md, log.md formats
- Same `[[wikilinks]]` convention
- Same raw source immutability contract
- Same sha256 drift detection mechanism

The skill adds features Hermes doesn't have (crystallize, audit, fetch-guard, staged writes) but these are additive — they don't modify the vault format in ways Hermes can't parse.

## Sources

- Hermes Agent llm-wiki SKILL.md v2.1.0 (`/Users/karlchow/Desktop/code/hermes-agent/skills/research/llm-wiki/SKILL.md`)
- kfchou/wiki-skills (111 stars) — primary base, HIGH Hermes compat
- vanillaflava/llm-wiki-claude-skills (29 stars) — crystallize, reliability scoring, templates
- daniel8824-del/claude-wiki-verbs (0 stars) — installer, 4-tier search
- atomicmemory/llm-wiki-compiler (934 stars) — hash-based change detection
- Codex adversarial review (2026-05-02) — 4 high-severity findings
