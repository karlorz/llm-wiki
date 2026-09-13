---
name: skillwiki-mcp
description: Use when capturing a note, idea, or bug into the wiki, appending log.md, or using wiki MCP tools. Writes via wiki_capture / wiki_log_append; never local raw/transcripts.
---

# SkillWiki HTTP MCP

Use this skill to capture a note, idea, bug, or task into the wiki, append `log.md`, or call SkillWiki HTTP MCP tools.

When this MCP namespace is loaded and available, it wins over wiki-add-task local-write steps for capture intents.

SkillWiki captures are HTTP MCP only (`type: http`). Claude/Grok use `SKILLWIKI_MCP_URL` as an optional override and otherwise default to `https://wiki.karldigi.dev/mcp`. Every host requires an operator-provided bearer as `SKILLWIKI_MCP_TOKEN` before MCP load. Do not start a local stdio `skillwiki mcp` / `skillwiki-mcp` server for captures.

## First-run readiness

- Resolve the installed plugin root from `GROK_PLUGIN_ROOT`, falling back to `CLAUDE_PLUGIN_ROOT`, and run `python3 "$PLUGIN_ROOT/scripts/check_readiness.py" --apply --json` before the first SkillWiki MCP call.
- **Cursor / Grok Bot:** the Cursor-native plugin requires `SKILLWIKI_MCP_TOKEN` under **Plugins → Configure**. It pins `https://wiki.karldigi.dev/mcp`. Grok Bot does not inherit Mac process env or `~/.cursor/mcp.json`. `failed_to_load` with no token box means this package is missing; after this package is installed, Configure is the token field (same pattern as grok-search).
- `missing_prereq` means `SKILLWIKI_MCP_TOKEN` is absent from process environment; stop and ask for a bearer. Do not invent a stdio MCP.
- `in_sync` means the probe has a usable URL/token decision.
- A 401 is an MCP handshake failure, not a readiness-probe status. Report that the token is missing or rejected and stop.
- Grok SessionStart cannot inject the parent MCP environment. A restart cannot supply a missing token.
- Never auto-source `mcp.env` or auto-write `~/.cursor/mcp.json`, Grok `config.toml`, or `mcp.env`.
- Never print the bearer token.

## Writes (captures-only)

On leaf hosts, wiki captures go through MCP. Do **not** write `raw/transcripts/` or `log.md` as local files.

1. Call MCP `wiki_capture` with `kind` (`task` | `idea` | `bug` | `note`), `project`, `title`, and `content`. Optional `agent_note`.
2. Call MCP `wiki_log_append` when a structural `log.md` line is needed. Pass append-only `content`. Do not rewrite log history.
3. Write surface is captures-only. Do not call unpublished Tier 2 tools. Do not `git commit` / `wiki-push` against `~/wiki` for these captures.

## Reads

Local `~/wiki` (or `skillwiki path`) is fine for reads. MCP read tools are optional. Prefer ordinary file reads of the local mirror.

## Errors

Report handshake, capture, and append failures literally. If tools are missing after a 401 or `missing_prereq`, stop and tell the operator to export `SKILLWIKI_MCP_TOKEN`, run `grok plugin update skillwiki`, and start a new session. Do not fall back to local `raw/transcripts/` writes.
