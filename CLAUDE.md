# CLAUDE.md

This repo ships the `skillwiki` CLI and 11 prompt-only SKILL.md files.

## Working in this repo

- The canonical spec is `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md`. Do not regress N1–N18.
- Skills are prompt-only Markdown — no build step, no LLM calls in the CLI.
- All deterministic logic lives under `packages/cli/src/`.
- Shared types live in `packages/shared/src/` and are imported via `@skillwiki/shared`.
- Tests are co-located with the package they cover; run them with `npm run -w <package> test`.

## Conventions

- Exit codes are stable across the v1 line. New failure classes get unused codes; never reassign existing codes.
- Every CLI subcommand returns a `Result<T>` envelope (`{ ok, data }` or `{ ok: false, error, detail? }`).
- `--human` MUST NOT alter exit codes (N2).
- Files under `raw/` MUST NOT be modified after ingestion (N9).

## Where things live

- Schemas: `packages/shared/src/schemas.ts`.
- Subcommand implementations: `packages/cli/src/commands/<name>.ts`.
- SKILL.md files: `packages/skills/<skill-name>/SKILL.md`.
- Templates: `packages/cli/templates/`.
- Claude plugin manifest: `packages/skills/.claude-plugin/plugin.json`.
- Claude marketplace manifest: `.claude-plugin/marketplace.json` (repo root). Skill discovery is driven by `plugin.json`'s `"skills": "./"` field; `marketplace.json` points the plugin source at `./packages/skills`.

## Distribution channels

The skills ship through two independent channels — keep both working:

1. **Claude Code plugin** — `/plugin marketplace add karlorz/llm-wiki` then `/plugin install skillwiki@llm-wiki`. Discovery is driven by `packages/skills/.claude-plugin/plugin.json` with a SessionStart hook that auto-injects the `using-skillwiki` onboarding skill.
2. **npm CLI installer** — `npx skillwiki install` copies SKILL.md files into `~/.claude/skills/` via the `install` subcommand (see `packages/cli/src/commands/install.ts`).

Changing the layout under `packages/skills/<skill>/` requires updating BOTH `packages/skills/.claude-plugin/plugin.json` AND the `install` subcommand's directory scan.
