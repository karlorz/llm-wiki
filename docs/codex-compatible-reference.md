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

Canonical skill and agent changes require materialization before they are
validated or released: edit `packages/skills/<skill>/SKILL.md` or
`packages/skills/agents/*.md`, then run `npm run materialize:plugins` and
`npm run materialize:plugins:check`. Do not hand-edit the downstream mirrors.
Downstream prompts must feature-detect `skillwiki page publish --help` before
using the transactional publisher and fail closed if it is unavailable; update
the active SkillWiki CLI/plugin channel instead of restoring direct typed-page,
index, or log writes.

## MCP connection and authentication

Read the installed `skillwiki-mcp` skill before the first wiki MCP call. The
local skills package, a direct HTTP MCP server, and the hosted **SkillWiki MCP**
app have separate activation and authentication state.

| Component | Connection | Authentication |
| --- | --- | --- |
| Local SkillWiki skills and hooks | Packaged workflows | Plugin installation and hook trust |
| Bundled `skillwiki_native` MCP | Direct `https://wiki.karldigi.dev/mcp` | Operator-provided `SKILLWIKI_MCP_TOKEN` in the Codex process environment |
| Hosted `codex_apps` SkillWiki MCP | Account-managed app connector | Private OAuth sign-in and workspace consent |

The canonical Codex MCP asset is `packages/skills/codex-mcp.json`. The
materializer copies it to `packages/codex-skills/codex-mcp.json`, referenced by the
Codex manifest's `mcpServers` field. The server uses the native
`bearer_token_env_var` field. The endpoint is fixed; `SKILLWIKI_MCP_URL` overrides
in other clients do not apply to this asset. The separate `skillwiki_native`
name keeps it distinct from registered app mappings.

Verified against Codex CLI **0.164.0** and its versioned
[plugin parser](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-mcp/src/plugin_config.rs)
and [HTTP MCP schema](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/mcp_types.rs).
That parser preserves `${VAR}` and `${VAR:-default}` literally and does not map
Claude-style `headers` to native `http_headers`. Keep the existing Claude/Grok
asset separate. Credentials belong in the process environment; the package
contains only the variable name. Installation does not issue credentials.

### Select and verify one route

- Native Codex prefers the configured direct connection. Discover actual tool
  names and schemas; the usual direct prefix is `mcp__skillwiki_native__`.
- ChatGPT web uses its hosted connector. When only
  `mcp__codex_apps__skillwiki_mcp_*` tools exist in Codex, explicitly identify
  that hosted route. A skills-only installation through v0.10.130 supplied no
  direct MCP declaration.
- If both routes exist, follow the user's selection; the native default is
  direct MCP. Before writing, use one read-only `wiki_context` or `wiki_status`
  call to verify the selected connection's default vault. The same endpoint can
  authenticate different identities with different allowed vaults and tools.
- Authentication or permission failure stops that route. Obtain explicit
  approval before switching connections or identities. Hosted OAuth reconnect
  and direct bearer provisioning are separate recovery actions.

### Upgrade and private provisioning

After this source change is released, refresh the marketplace and installed
plugin through the normal Codex channel, then start a new session. Existing
cached versions keep their old files until refreshed. Verify the installed
manifest's `mcpServers` path and installed `codex-mcp.json`; inspect advertised tools
and, where supported, safe fields from `codex mcp list --json`.

An operator supplies an issued host bearer privately in the environment that
launches Codex. Desktop apps and remote workers may have different launch
environments. Never paste the token into chat, commit it, copy another agent's
credential, or auto-write user configuration. If the variable is absent, stop
for provisioning. A parser listing confirms configuration only; a live read-only
MCP call is required to verify authentication. Codex 0.164.0 can report
`auth_status: bearer_token` even when the referenced variable is absent; that
label describes the configured method. Credential presence and validity require
separate verification.
Keep the hosted connection until
an explicitly approved replacement has passed that check.

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

# 3) Skill count served by plugin root (derive from command output)
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
