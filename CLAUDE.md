# CLAUDE.md

This repo ships the `skillwiki` CLI and 18 prompt-only SKILL.md files.

## Working in this repo

- The canonical spec is in the vault at `~/wiki/projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md`. Do not regress N1–N18. Historical specs/plans are archived in `~/wiki/projects/llm-wiki/history/`.
- Skills are prompt-only Markdown — no build step, no LLM calls in the CLI.
- All deterministic logic lives under `packages/cli/src/`.
- Shared types live in `packages/shared/src/` and are imported via `@skillwiki/shared`.
- Tests are co-located with the package they cover; run them with `npm run -w <package> test`.
- Local dev build: `npm run -w packages/cli build` (output in `packages/cli/dist/`). Run with `node packages/cli/dist/cli.js <command>`.
- Run tests: `npx vitest run packages/cli/test/` (all) or `npx vitest run packages/cli/test/commands/doctor.test.ts` (single file).

## Conventions

- Exit codes are stable across the v1 line. New failure classes get unused codes; never reassign existing codes.
- Every CLI subcommand returns a `Result<T>` envelope (`{ ok, data }` or `{ ok: false, error, detail? }`).
- `--human` MUST NOT alter exit codes (N2).
- Files under `raw/` MUST NOT be modified after ingestion (N9).

## E2E test suite

Four scripts in `scripts/`, all sourcing `e2e-common.sh` for shared helpers:

- **`verify-manifests.sh`** — validates manifest consistency: version sync across 12 files, skill count in descriptions matches actual, every skill dir has SKILL.md. Runs as a CI gate before build.
- **`e2e-local.sh`** — builds from source, runs all CLI commands locally (130 assertions). No network required.
- **`e2e-remote.sh`** — upgrades skillwiki on the target host (default sg02) via `npm install -g skillwiki@latest`, then runs the full CLI suite over SSH. Host selection via `HOST_ENV=scripts/hosts/<name>.env`.
- **`e2e-plugin.sh`** — verifies the Claude Code plugin channel on sg01: version, 18 SKILL.md files, skill discovery via claude, and CLI commands through the plugin path (27 assertions).
- **`e2e-vault-sync-local.sh`** — macOS-only vault-sync install/uninstall e2e. **Local invocation only — NOT a CI gate.** Dry-run by default; set `LOCAL_LIFECYCLE=true` for full lifecycle on fresh hosts.
- **`e2e-vault-sync-remote.sh`** — generic remote vault-sync e2e (reads `HOST_ENV`, sg01 runs read-only branch). **Local invocation only — NOT a CI gate** (SSH-out from GitHub Actions is not used; see `.github/_archive/2026-05-25-workflows/`).

Assertion counts are approximate — they include loop-expanded iterations (e.g., a `for` loop over 10 skills produces 10 runtime assertions from 1 source line). Hard Rule 15: counts are not a contract; only exit code matters.

## Where things live

- Schemas: `packages/shared/src/schemas.ts`.
- Subcommand implementations: `packages/cli/src/commands/<name>.ts`.
- SKILL.md files: `packages/skills/<skill-name>/SKILL.md`.
- Templates: `packages/cli/templates/`.
- CLI wrapper: `packages/skills/bin/skillwiki` (npx delegation for plugin PATH injection).
- Claude plugin manifest: `packages/skills/.claude-plugin/plugin.json`.
- Claude marketplace manifest: `.claude-plugin/marketplace.json` (repo root). Skill discovery is driven by `plugin.json`'s `"skills": "./"` field; `marketplace.json` points the plugin source at `./packages/skills`.
- Codex plugin manifest: `packages/codex-skills/.codex-plugin/plugin.json` (materialized copy of `packages/skills/.codex-plugin/plugin.json`).
- Codex marketplace manifest: `.agents/plugins/marketplace.json` (repo root). Plugin discovery in Codex is driven by marketplace entries that point at the Codex-native root `./packages/codex-skills`, which exposes `skills/` and `hooks/hooks-codex.json` but not the Claude default `hooks/hooks.json`.
- Antigravity/`agy` root plugin manifests: `plugin.json` (local validation/path installs) and `.claude-plugin/plugin.json` (GitHub URL installs). Direct install is `agy plugin install https://github.com/karlorz/llm-wiki`; root `skills/`, `agents/`, and `hooks.json` are materialized mirrors of the canonical files under `packages/skills/`.
- Version bump: `npm run bump <version>` — syncs version across all 12 manifests (`scripts/bump-version.sh`).

## Distribution channels

The skills ship through multiple independent channels — keep them all working:

1. **Claude Code plugin** — `/plugin marketplace add karlorz/llm-wiki` then `/plugin install skillwiki@llm-wiki`. Discovery is driven by `packages/skills/.claude-plugin/plugin.json` with a SessionStart hook that auto-injects the `using-skillwiki` onboarding skill. The `bin/skillwiki` npx wrapper is auto-injected into PATH when the plugin is enabled.
2. **Codex plugin marketplace** — `codex plugin marketplace add karlorz/llm-wiki@dev` (GitHub source) or `codex plugin marketplace add /path/to/llm-wiki` (local source). Then open Codex TUI (`codex`), run `/plugins`, select marketplace `llm-wiki`, and install plugin `skillwiki`. Discovery is driven by `.agents/plugins/marketplace.json` and `packages/codex-skills/.codex-plugin/plugin.json`; Codex SessionStart bootstrap uses `hooks/hooks-codex.json` and `hooks/session-start-codex`.
3. **Antigravity CLI (`agy`) root plugin** — `agy plugin install https://github.com/karlorz/llm-wiki`. Local path validation is driven by repo-root `plugin.json`; GitHub URL install requires the matching `.claude-plugin/plugin.json` marker. Both point skills to `./skills/` and agents to `./agents/`. `scripts/verify-manifests.sh` guards the materialized root layout, rejects symlink regressions, and requires both manifests to match.
4. **npm CLI installer** — `npx skillwiki install` copies SKILL.md files and the `bin/skillwiki` wrapper into `~/.claude/skills/` via the `install` subcommand (see `packages/cli/src/commands/install.ts`).
5. **vault-sync plugin** — `claude plugin install vault-sync@llm-wiki`. Sibling plugin to skillwiki, ships the cross-platform sync infrastructure (rclone push, fetch-notify, presync, snapshot, Linux FUSE freshness refresh). Installed via `/vault-sync-install`; OS-detects launchd vs systemd-user.

Changing the layout under `packages/skills/<skill>/` requires updating `packages/skills/.claude-plugin/plugin.json`, `packages/skills/.codex-plugin/plugin.json`, the materialized `packages/codex-skills` layout, the materialized root `agy` layout (`skills/`, `agents/`, `plugin.json`, `.claude-plugin/plugin.json`), and the `install` subcommand's directory scan. If the plugin root path changes, update both marketplace manifests (`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`).

## Dev vs prod plugin source

- **Global** (`~/.claude/settings.json`): `llm-wiki` marketplace → `"source": "github"`. All projects get the production plugin.
- **Project-local** (`.claude/settings.local.json`, gitignored): overrides `llm-wiki` → `"source": "directory"` so this repo uses dev source.
- **Same marketplace name is required** — the name must match `marketplace.json`'s `"name"` field. A distinct name like `llm-wiki-dev` will fail with "Plugin not found in marketplace".
- **Same cache dir** — Claude Code shares `~/.claude/plugins/cache/llm-wiki/` across scopes; you cannot have two versions at different scopes simultaneously.
- **Plugin install scope:** `claude plugin install skillwiki@llm-wiki --scope user` (global) or `--scope local` (project). Uninstall must match: `--scope local` for directory-sourced installs.
- **After changing source or scope:** clear cache (`rm -rf ~/.claude/plugins/cache/llm-wiki`) then reinstall. Settings changes do not auto-flush the cache.

## Plugin release workflow

- **Local dev marketplace:** `claude plugin marketplace add /path/to/llm-wiki` (pass the repo root, not `.claude-plugin/` — the CLI appends `.claude-plugin/` automatically). Then `claude plugin install skillwiki@llm-wiki`.
- **Codex local dev marketplace:** `codex plugin marketplace add /path/to/llm-wiki`, then in TUI run `/plugins` and install `skillwiki` from marketplace `llm-wiki`.
- **Codex GitHub marketplace source:** `codex plugin marketplace add karlorz/llm-wiki@dev` (or `--ref <branch|tag>` with Git URLs). Refresh Git-backed marketplace sources with `codex plugin marketplace upgrade llm-wiki`.
- **Pushing to `dev` = releasing the plugin.** There is no version pinning or channel tag for Claude Code plugins. Every push to the default branch (`dev`) is what users get on `plugin install`.
- **Version gate:** `/plugin update` only detects changes when the `version` field in `plugin.json` is bumped. New commits without a version bump are ignored.
- **npm is a separate channel:** `npm publish --tag beta` gives CLI users a beta track independent of the plugin channel. Default dist-tag is `latest`; use `--tag beta` in `skillwiki update` for pre-release.
- **Always run `e2e-plugin.sh` before pushing to `dev`** — CI runs it automatically when SSH secrets are configured, but run it locally too if you can.
- **Updating plugin on test hosts:** the marketplace cache at `~/.claude/plugins/marketplaces/<name>/` does NOT auto-update. Run `git fetch origin && git reset --hard origin/dev` inside it, then `claude plugin uninstall skillwiki@llm-wiki && rm -rf ~/.claude/plugins/cache/llm-wiki && claude plugin install skillwiki@llm-wiki`.
- **Shell command, not slash command:** use `claude plugin install` (no slash) from the terminal. The `/plugin` slash command only works inside an interactive Claude session.

## Architecture: Three Layers

The vault at `~/wiki` has three layers. No other top-level directories exist — extend Layer 2 via SCHEMA.md tag taxonomy if needed.

```
wiki/
├── SCHEMA.md              # Conventions, structure rules, domain config
├── index.md               # Sectioned content catalog with one-line summaries
├── log.md                 # Chronological action log (append-only, rotated)
│
├── raw/                    # Layer 1: Immutable source material
│   ├── articles/           #   Web articles, clippings, fetched URL content
│   ├── papers/             #   PDFs, arxiv papers, long-form research
│   ├── transcripts/        #   Meeting notes, interviews, ad-hoc captures
│   └── assets/             #   Images, diagrams referenced by sources
│
├── entities/               # Layer 2: Typed knowledge — people, orgs, products, models
├── concepts/               # Layer 2: Typed knowledge — topics, patterns, ideas
├── comparisons/            # Layer 2: Typed knowledge — side-by-side analyses
├── queries/                # Layer 2: Typed knowledge — filed query results
├── meta/                   # Layer 2: Cross-project synthesis (must name ≥2 projects)
│
├── projects/               # Layer 3: Per-project lifecycle workspaces
│   └── {slug}/
│       ├── work/           #     Work items (spec + plan + retro per item)
│       ├── compound/       #     Distilled lessons, patterns, gotchas
│       ├── architecture/   #     ADRs and structural decisions
│       └── history/        #     Archived specs/plans (write-once)
│
└── _archive/               # Superseded typed-knowledge pages (moved, not deleted)
```

- **Layer 1 — Raw (`raw/`):** Immutable after ingest. `raw/transcripts/` doubles as the ad-hoc capture point — meeting notes, quick ideas, and unprocessed drafts go here. **No `inbox/` directory.** Do not invent new top-level directories. Three entry points for ad-hoc capture:
  - `/wiki-add-task <text>` — from inside a Claude session, creates `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md` with raw-valid frontmatter
  - **Filesystem drop** — create any `.md` file in `raw/transcripts/` when not in a Claude session (Obsidian, editor, sync); dev-loop discovers it on next cycle
  - **Dev-loop discovery** — automatic scan of `raw/transcripts/` for new files, surfaces as claimable work
- **Layer 2 — Typed Knowledge:** Agent-owned pages with `^[raw/...]` citation markers. Global scope — project association via `provenance_projects:` frontmatter, not directory nesting.
- **Layer 3 — Project Workspaces:** Per-project lifecycle directories with `work/`, `compound/`, `architecture/`, and `history/`.

## Project vault

- The vault at `~/wiki` is the canonical project knowledge base. All specs, plans, and retros land there via `skillwiki` skills.
- **New** specs and plans go into work items via `proj-work` → `projects/llm-wiki/work/YYYY-MM-DD-{slug}/spec.md` or `plan.md`. The `history/{specs,plans}/` folder is **archive-only** for superseded historical documents — do not write new work there. Do not recreate `docs/superpowers/`.
- The dev-loop skill (`dev-loop:1.5.1`) drives the PRD+skillwiki workflow. It reads project config from `.claude/dev-loop.config.md`. Legacy commands are archived at `~/.claude/commands/_archive/2026-05-07/`.

## CI gates

CI runs four validation stages before allowing merge:

1. **verify-manifests** — version sync, skill count, SKILL.md presence (no build needed, runs first)
2. **build-and-test** — unit tests across 3 platforms + install --dry-run smoke
3. **e2e-local** — full CLI E2E against built binary
4. **e2e-plugin** — plugin channel E2E on sg01 (only when `SSH_PRIVATE_KEY` secret is set; skipped for fork PRs)

Run `scripts/verify-manifests.sh` locally before pushing to catch manifest drift early.

## Vault sync infrastructure (macOS dev host)

Two launchd jobs keep `~/wiki` in sync with the canonical stores. Source-of-truth for all sync scripts is now `packages/vault-sync/`. Reference: `~/wiki/projects/llm-wiki/architecture/2026-05-23-vault-sync-topology.md`.

- **`com.karlchow.wiki-push`** (installed by `vault-sync-install`, source `packages/vault-sync/scripts/wiki-push.sh`, every 60 s) — pushes macOS file changes to SeaweedFS S3 via `rclone copy --update`. Push-only; never deletes on remote. Filter file `~/.config/rclone/wiki-push-filters.txt` excludes credentials (`remotely-save/data.json`), advisory locks (`.skillwiki/sync.lock`), `.claude/settings.local.json`, and noise.
- **`com.karlchow.wiki-fetch`** (installed by `vault-sync-install`, source `packages/vault-sync/scripts/wiki-fetch-notify.sh`, every 5 min) — read-only `git fetch origin main`; fires notification only on positive delta. No working-tree writes.
- **`vault-presync` skill** (now in `vault-sync` plugin, was vault-local `wiki-presync`) — runs lint gate + collision dedup + `git pull --rebase`. Invoke manually before pushing via `/vault-presync --execute`.
- **Retired**: `com.karlchow.seaweedfs-bisync.plist.disabled` — bidirectional bisync, killed 2026-05-23. Do not re-enable. Tombstone: see `~/wiki/raw/transcripts/2026-05-23-task-tombstone-bisync-plist.md`.

## Cross-host sync gotchas (read before touching sg01)

- **sg01 `wiki-snapshot-v3.sh` source-of-truth is now `packages/vault-sync/scripts/wiki-snapshot.sh`** — uses `rclone sync` (destructive). A `--max-delete 10` guard was added 2026-05-23 to abort the cycle before mass deletions. **Do not remove this flag without a deliberate replacement** — without it, any momentary S3 inconsistency mass-deletes files from GitHub (this happened during 2026-05-23 session, see `raw/transcripts/2026-05-23-bug-sg01-snapshot-destructive-rclone-sync.md`). Backup of original: `/root/.hermes/scripts/wiki-snapshot-v3.sh.bak.20260523-180658`.
- **sg01 is `protected: true` in `fleet.yaml`** — CI cannot run install/uninstall against sg01. Only read-only verify via `workflow_dispatch`. See `projects/llm-wiki/architecture/fleet.yaml`.
- **Single-writer-git is enforced by `fleet.yaml`**: only sg01 produces "Snapshot $DATE" commits; macOS pushes its own edits. See `queries/multi-writer-git-sync-conflict-prevention.md`.
- **GitHub is canonical for promoted typed-knowledge**; S3 is canonical for agent-edit transients. See `concepts/vault-write-authority-model.md`.

## Current counts (2026-05-30)

- 18 + 6 SKILL.md files (skillwiki + vault-sync)
- 45 command files in `packages/cli/src/commands/`, 23 utilities in `src/utils/`
- 77 test files in cli + 10 shared
- 1046 tests passing
- Lint buckets: 0 error, 0 warning (clean vault), 9 info (incl. `bridges`, `sparse_community`, `orphaned_citations`, `missing_tldr`, `stale_sections`, `cli_refs`); `missing_diagram` is warning severity for architecture-tagged pages
- Lint --fix supports: `legacy_citation_style`, `wikilink_citation`, `missing_overview`, `missing_tldr`
- Lint --only supports: any valid bucket name (e.g., `lint --only cli_refs`)
- Stale --project supports: scope to a single project (e.g., `stale --project llm-wiki`)
- Exit codes: 50 total; highest: `LOG_APPEND_LOCK_HELD (49)`
- Config keys: `BACKUP_ENDPOINT`, `BACKUP_BUCKET`, `BACKUP_REGION`, `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY`; `AUTO_COMMIT` (default: enabled, opt-out — **only triggers on skillwiki CLI writes, NOT on Edit/Write tool calls or bash `mv`/`rm`. Plain file edits leave a dirty working tree.**)
- `doctor` checks: 33 (incl. 5 S3 mount health checks + 6 vault_sync_* checks + 5 vault_metric_* info rows); `CheckStatus` includes `info` severity (pass < info < warn < error); `info` does not affect exit code
- Page-rewriting commands (`frontmatter-fix`, `tag-sync`, `migrate-citations`, `lint --fix`, `drift`) use `safeWritePage` (atomic temp+rename, body-shrink guard at 0.5 ratio) as defense-in-depth against the 2026-05-22 SeaweedFS rclone VFS write-back race.
