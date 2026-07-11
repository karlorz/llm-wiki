# Codex Plugin Reference

This repository includes a Codex-ready plugin marketplace package for
`skillwiki`, plus a sibling `vault-sync` marketplace entry.

Official platform docs (accessed 2026-07-10):

- Plugins overview: https://developers.openai.com/codex/plugins/
- Build plugins / marketplaces: https://developers.openai.com/codex/plugins/build

## Canonical files

- Marketplace manifest: `.agents/plugins/marketplace.json`
- Canonical Codex plugin manifest source: `packages/skills/.codex-plugin/plugin.json`
- Materialized Codex plugin root: `packages/codex-skills/`
- Materialized Codex plugin manifest: `packages/codex-skills/.codex-plugin/plugin.json`
- Canonical skill source: `packages/skills/<skill>/SKILL.md`
- Codex skills mirror: `packages/codex-skills/skills/<skill>/SKILL.md`
- Sibling vault-sync Codex plugin: `packages/vault-sync/.codex-plugin/plugin.json`

`packages/skills/.codex-plugin/plugin.json` and
`packages/codex-skills/.codex-plugin/plugin.json` are kept byte-identical by the
materialize pipeline. Prefer the materialized plugin root when installing.

## What is supported

- Local marketplace source install
- GitHub/Git marketplace source install
- Plugin directory install/enable via `/plugins` (CLI) or the Codex app Plugins UI
- Marketplace refresh via `codex plugin marketplace upgrade`
- Repo-scoped marketplace at `.agents/plugins/marketplace.json`

## Install methods

### Method A: local repo source (dev)

```bash
cd /path/to/llm-wiki
codex plugin marketplace add .
```

Then inside Codex TUI:

```text
/plugins
```

Choose marketplace `llm-wiki`, open `skillwiki`, and select `Install plugin`.
The same marketplace also exposes `vault-sync` for operational host tooling.

### Method B: GitHub source (shared/team)

```bash
codex plugin marketplace add karlorz/llm-wiki@main
# equivalent:
# codex plugin marketplace add https://github.com/karlorz/llm-wiki.git --ref main
```

Then inside Codex TUI:

```text
/plugins
```

Install `skillwiki` from marketplace `llm-wiki`.

### Refresh after new commits (Git-backed sources)

```bash
codex plugin marketplace upgrade llm-wiki
```

Restart Codex and re-open `/plugins`.

## Quick verification checklist

```bash
cd /path/to/llm-wiki

# 1) Marketplace metadata (currently skillwiki + vault-sync)
cat .agents/plugins/marketplace.json

# 2) Codex plugin manifest (materialized root)
cat packages/codex-skills/.codex-plugin/plugin.json

# 3) Skill count served by plugin root (must be 18)
find packages/codex-skills/skills -mindepth 2 -maxdepth 2 -name SKILL.md -print | wc -l

# 4) Mirror drift check
npm run materialize:plugins:check

# 5) Optional: check configured marketplaces
rg "marketplaces\\.llm-wiki" ~/.codex/config.toml
```

## Structural guarantees for this repo

- `.agents/plugins/marketplace.json` currently exposes two plugins:
  `skillwiki` (`./packages/codex-skills`) and `vault-sync`
  (`./packages/vault-sync`).
- `packages/skills/.codex-plugin/plugin.json` is the authored Codex plugin
  entry point; `packages/codex-skills/` is the install-facing root.
- `source.path` for skillwiki is `./packages/codex-skills`, because Codex
  discovers multi-skill plugins reliably from `skills/<skill>/SKILL.md`.
- `packages/skills/<skill>/SKILL.md` remains the canonical authored source.
- `packages/skills/skills/`, `packages/codex-skills/skills/`, root `skills/`,
  root `agents/`, and root `hooks.json` are materialized mirrors for platform
  compatibility.
- Run `npm run materialize:plugins` after changing canonical skill, agent, or
  hook assets. Run `npm run materialize:plugins:check` for read-only drift
  detection.

## wiki-sync / vault-sync convergence notes

- Stale clean rebase sequencer state is cleared with a recovery ref under
  `refs/vault-sync/recovery/` plus `git rebase --quit` (never abort-reset).
- Active rebases (`REBASE_HEAD` / unmerged paths) fail closed and are left untouched.
- Only fully proven snapshot-materialized local commits may be dropped during
  pull/rebase (exact ordinary-path blobs; byte-identical added `## ` log sections).
- Publication and presync gate on `skillwiki sync lint-delta --base-ref origin/main`:
  block only when `new_errors > 0`; inherited full debt remains visible;
  malformed or missing delta evidence fails closed (never silent lint skip).

