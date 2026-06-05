---
name: wiki-init
description: Bootstrap a CodeWiki vault — domain-aware SCHEMA.md, index.md, log.md, and ~/.skillwiki/.env binding. Use when starting a fresh vault.
---

# wiki-init

## When This Skill Activates

- User asks to create, build, or start a vault, wiki, or knowledge base.
- The resolved vault path (see step 0) does not yet contain SCHEMA.md.

## Pre-orientation reads

None for the first run.

## Steps

0. **Resolve target.** Run `skillwiki path --init-time` to see what target the CLI will pick. Confirm with the user, or override with `--target <dir>`.
1. Verify target is empty or has no SCHEMA.md.
2. Ask the domain question: "What knowledge domain will this vault cover? Be specific."
3. Propose a 10–15 tag taxonomy tailored to the domain. Confirm or accept the user's revision.
4. Ask the language question: "What language should generated page prose use? Default is `en`. Aliases like `chinese-traditional` or `zh-Hant` are accepted."
5. Run `skillwiki init --target <dir> --domain "<answer>" --taxonomy "<comma list>" --lang "<lang>"`.
6. **Suggest first sources.** Propose 3–5 initial sources (URLs, papers, articles) appropriate to the domain. Prompt the user to provide the first one to ingest, then hand off to wiki-ingest.

## Stop conditions

- Target non-empty and `--force` not consented.
- `~/.skillwiki/.env` already binds a different vault or language and `--force` not consented.

## Forbidden

- Modifying anything outside the target directory or `~/.skillwiki/.env`.
- Writing to `~/.hermes/.env` (read-only fallback).
- Running any LLM-driven content generation in this skill.
