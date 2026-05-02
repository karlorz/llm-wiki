---
name: wiki-init
description: Bootstrap a CodeWiki vault — directory tree, SCHEMA.md, index.md, log.md. Use when starting a fresh vault.
---

# wiki-init

## When to invoke
- User asks to bootstrap a new knowledge vault.
- Vault root is empty or missing SCHEMA.md.

## Pre-orientation reads
None for the first run. If a target directory already contains files, STOP and surface the conflict — do not overwrite.

## Inputs
1. Target directory (default: cwd).
2. Domain question: "What knowledge domain will this vault cover?" — used to seed `tags:` and SCHEMA notes.

## Steps
1. Verify target directory is empty or missing.
2. Run `skillwiki install --dry-run` against target to preview side effects (skip if not installing skills here).
3. Create directory tree: `raw/{articles,papers,transcripts,assets}/`, `entities/`, `concepts/`, `comparisons/`, `queries/`, `meta/`, `projects/`.
4. Write `SCHEMA.md`, `index.md`, `log.md` from packaged templates (resolved via `npx skillwiki install --target <vault>` or by reading `node_modules/skillwiki/templates/`).
5. Append a single `log.md` entry: "Vault initialized — domain: <answer>".

## Stop conditions
- Target non-empty.
- Cannot resolve templates path.

## Forbidden
- Modifying anything outside the target directory.
- Running any LLM-driven content generation in this skill.
