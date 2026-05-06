# CLAUDE.md

This repo ships the `skillwiki` CLI and 14 prompt-only SKILL.md files.

## Working in this repo

- The canonical spec is in the vault at `~/wiki/projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md`. Do not regress N1–N18. Historical specs/plans are archived in `~/wiki/projects/llm-wiki/history/`.
- Skills are prompt-only Markdown — no build step, no LLM calls in the CLI.
- All deterministic logic lives under `packages/cli/src/`.
- Shared types live in `packages/shared/src/` and are imported via `@skillwiki/shared`.
- Tests are co-located with the package they cover; run them with `npm run -w <package> test`.

## Conventions

- Exit codes are stable across the v1 line. New failure classes get unused codes; never reassign existing codes.
- Every CLI subcommand returns a `Result<T>` envelope (`{ ok, data }` or `{ ok: false, error, detail? }`).
- `--human` MUST NOT alter exit codes (N2).
- Files under `raw/` MUST NOT be modified after ingestion (N9).

## E2E test suite

Three scripts in `scripts/`, all sourcing `e2e-common.sh` for shared helpers:

- **`e2e-local.sh`** — builds from source, runs all CLI commands locally (130 assertions). No network required.
- **`e2e-remote.sh`** — upgrades skillwiki on sg01 via `npm install -g skillwiki@beta`, then runs the full CLI suite over SSH (48 assertions).
- **`e2e-plugin.sh`** — verifies the Claude Code plugin channel on sg01: version, 14 SKILL.md files, skill discovery via claude, and CLI commands through the plugin path (27 assertions).

## Where things live

- Schemas: `packages/shared/src/schemas.ts`.
- Subcommand implementations: `packages/cli/src/commands/<name>.ts`.
- SKILL.md files: `packages/skills/<skill-name>/SKILL.md`.
- Templates: `packages/cli/templates/`.
- CLI wrapper: `packages/skills/bin/skillwiki` (npx delegation for plugin PATH injection).
- Claude plugin manifest: `packages/skills/.claude-plugin/plugin.json`.
- Claude marketplace manifest: `.claude-plugin/marketplace.json` (repo root). Skill discovery is driven by `plugin.json`'s `"skills": "./"` field; `marketplace.json` points the plugin source at `./packages/skills`.
- Version bump: `npm run bump <version>` — syncs version across all 6 manifests (`scripts/bump-version.sh`).

## Distribution channels

The skills ship through two independent channels — keep both working:

1. **Claude Code plugin** — `/plugin marketplace add karlorz/llm-wiki` then `/plugin install skillwiki@llm-wiki`. Discovery is driven by `packages/skills/.claude-plugin/plugin.json` with a SessionStart hook that auto-injects the `using-skillwiki` onboarding skill. The `bin/skillwiki` npx wrapper is auto-injected into PATH when the plugin is enabled.
2. **npm CLI installer** — `npx skillwiki install` copies SKILL.md files and the `bin/skillwiki` wrapper into `~/.claude/skills/` via the `install` subcommand (see `packages/cli/src/commands/install.ts`).

Changing the layout under `packages/skills/<skill>/` requires updating BOTH `packages/skills/.claude-plugin/plugin.json` AND the `install` subcommand's directory scan.

## Plugin release workflow

- **Local dev marketplace:** `claude plugin marketplace add /path/to/llm-wiki` (pass the repo root, not `.claude-plugin/` — the CLI appends `.claude-plugin/` automatically). Then `claude plugin install skillwiki@llm-wiki`.
- **Pushing to `dev` = releasing the plugin.** There is no version pinning or channel tag (`@beta`) for Claude Code plugins. Every push to the default branch (`dev`) is what users get on `plugin install`.
- **Version gate:** `/plugin update` only detects changes when the `version` field in `plugin.json` is bumped. New commits without a version bump are ignored.
- **npm is a separate channel:** `npm publish --tag beta` gives CLI users a beta track independent of the plugin channel.
- **Always run `e2e-plugin.sh` before pushing to `dev`** — there is no publish gate.
- **Updating plugin on test hosts:** the marketplace cache at `~/.claude/plugins/marketplaces/<name>/` does NOT auto-update. Run `git fetch origin && git reset --hard origin/dev` inside it, then `claude plugin uninstall skillwiki@llm-wiki && rm -rf ~/.claude/plugins/cache/llm-wiki && claude plugin install skillwiki@llm-wiki`.
- **Shell command, not slash command:** use `claude plugin install` (no slash) from the terminal. The `/plugin` slash command only works inside an interactive Claude session.

## Project vault

- The vault at `~/wiki` is the canonical project knowledge base. All specs, plans, and retros land there via `skillwiki` skills.
- **New** specs and plans go into work items via `proj-work` → `projects/llm-wiki/work/YYYY-MM-DD-{slug}/spec.md` or `plan.md`. The `history/{specs,plans}/` folder is **archive-only** for superseded historical documents — do not write new work there. Do not recreate `docs/superpowers/`.
- The dev-loop commands (`~/.claude/commands/dev-loop.md`, `dev-loop-research.md`) drive the PRD+skillwiki workflow. Their shared prompt lives in user memory at `~/.claude/projects/.../memory/dev-loop-prompt.md`.

## Current counts (2026-05-06)

- 14 SKILL.md files in `packages/skills/`
- 28 CLI subcommands in `packages/cli/src/commands/`
- 29 test files in `packages/cli/test/commands/`
- Lint buckets: 4 error, 10 warning, 3 info (incl. `page_structure`, `duplicate_frontmatter`, `missing_overview`)
