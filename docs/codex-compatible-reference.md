# Codex Plugin Reference

This repository includes a Codex-ready plugin marketplace package for
`skillwiki`.

## Canonical files

- Marketplace manifest: `.agents/plugins/marketplace.json`
- Codex plugin manifest: `packages/skills/.codex-plugin/plugin.json`
- Plugin skills root: `packages/skills/` (zero-copy, shared with Claude channel)

## What is supported

- Local marketplace source install
- GitHub/Git marketplace source install
- TUI plugin install/enable via `/plugins`
- Marketplace refresh via `codex plugin marketplace upgrade`

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

### Method B: GitHub source (shared/team)

```bash
codex plugin marketplace add karlorz/llm-wiki@dev
# equivalent:
# codex plugin marketplace add https://github.com/karlorz/llm-wiki.git --ref dev
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

# 1) Marketplace metadata
cat .agents/plugins/marketplace.json

# 2) Codex plugin manifest
cat packages/skills/.codex-plugin/plugin.json

# 3) Skill count served by plugin root (must be 18)
find packages/skills -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | wc -l

# 4) Optional: check configured marketplaces
rg "marketplaces\\.llm-wiki" ~/.codex/config.toml
```

## Structural guarantees for this repo

- `packages/skills/.codex-plugin/plugin.json` is the Codex plugin entry point.
- `.agents/plugins/marketplace.json` exposes one plugin: `skillwiki`.
- `source.path` is `./packages/skills`, so both Claude and Codex load the same
  skill files.
- Adding/removing a skill under `packages/skills/` is zero-copy across both
  plugin channels; there is no sync directory.
