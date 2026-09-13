# CodeWiki / skillwiki

Project-aware Karpathy-style knowledge base for Claude Code skills.

## Install

### Option A — Claude Code plugin (recommended)

```text
/plugin marketplace add karlorz/llm-wiki
/plugin install skillwiki@llm-wiki
```

The plugin ships 21 skills (`wiki-*`, `proj-*`, `wiki-add-task`, `wiki-adapter-prd`, `wiki-reingest`, `using-skillwiki`, `skillwiki-mcp`). They are namespaced by Claude Code as `llm-wiki:<skill>` (e.g. `llm-wiki:wiki-init`).

### Option B — npm CLI installer

```bash
npx skillwiki@latest install
```

This copies 21 SKILL.md files into `~/.claude/skills/` and writes `.claude/skills/wiki-manifest.json`. Use this when you want the skills available outside a Claude Code plugin context, or to seed `~/.claude/skills/` for tools that scan it directly.

### Option C — Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/karlorz/llm-wiki
```

The repository root includes an `agy`-compatible `plugin.json` plus a matching `.claude-plugin/plugin.json` marker for GitHub URL installs. Root `skills/` and `agents/` are materialized mirrors of the canonical files under `packages/skills/`. Derive the current skill and agent counts from those mirrors before validating:

```bash
agy plugin validate .
```

```bash
find skills -mindepth 2 -maxdepth 2 -name SKILL.md -print | wc -l
find agents -mindepth 1 -maxdepth 1 -name '*.md' -print | wc -l
```

After changing canonical skill, agent, or hook assets under `packages/skills/`,
regenerate install-facing mirrors before validating:

```bash
npm run materialize:plugins
npm run materialize:plugins:check
```

### Option D — Cursor / Grok Bot marketplace pin

Cursor / Grok Bot do not list this repo on the public
[Cursor Marketplace](https://cursor.com/marketplace). A GitHub or npm
release does not move the pin; Reinstall repeats the last indexed
snapshot. Check `cursor-agent plugin marketplace list --format json`.

If `"scope": "user"` for `llm-wiki` (operator GitHub add), Dashboard
Refresh / Auto Refresh does **not** apply. Follow
`cursor-github-marketplace-repin` (`status.sh`, then remove +
`add --git-ref`). After rempin, restore KEEP plugins (`skillwiki`,
`vault-sync`) via `/plugins` or `install-keep-plugins.sh` — Cursor CLI
`2026.08.25` has no `plugin install`. Grok Bot shares that Cursor
account list. Until the pin advances, use Option B or
`grok plugin update skillwiki`.

To update a **Team** marketplace admin row (`scope` is not `user`):

1. Push the release tag.
2. [Dashboard → Plugins](https://cursor.com/dashboard) → `karlorz/llm-wiki`
   → **Refresh** or Enable **Auto Refresh** (needs the
   [Cursor GitHub App](https://cursor.com/docs/integrations/github);
   re-index at most every 10 minutes).
3. Refocus or restart Cursor / Grok Bot.
4. Confirm
   `~/.cursor/plugins/cache/llm-wiki/skillwiki/<git-sha>/plugin.json`
   `version` matches the release.

If the SHA is unchanged, re-import `https://github.com/karlorz/llm-wiki`
in Team marketplace and Refresh again.

## Skills

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit`, `wiki-archive`, `wiki-reingest`, `wiki-adapter-prd`, `wiki-add-task`, `wiki-sync`, `wiki-canvas`, `wiki-gate-plan-mode`, `wiki-remove`, `wiki-freshness-repair` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |
| onboarding | `using-skillwiki` |
| mcp | `skillwiki-mcp` |

A sibling `vault-sync` plugin ships six operational skills (install, status, presync, snapshot, FUSE freshness, uninstall). It is packaged separately from the skillwiki skill set.

## CLI

`skillwiki` exposes a deterministic CLI consumed by the skills. Prefer the built
help over hard-coded counts:

```bash
npm run -w packages/cli build
node packages/cli/dist/cli.js --help
```

Use built `--help` as the authority for the current command surface rather
than a hard-coded count. To calculate the listed top-level commands from that
authority:

```bash
node packages/cli/dist/cli.js --help | awk '/^Commands:/{listed=1; next} listed && /^  [a-z]/{count++} END {print count}'
```

| Subcommand | Purpose |
|---|---|
| `init` | Bootstrap vault and install the importable `_Templates/web-clipper/llm-wiki-clippings.json` capture template. |
| `install` | Cross-platform skills installer (copies or symlinks SKILL.md files). |
| `hash <file>` | sha256 of body bytes after closing `---`. |
| `validate <file>` | Frontmatter Zod validation. |
| `lint <vault>` | Vault health check (stale pages, dedup, taxonomy, citations, sources). |
| `health <vault>` | Bounded whole-system wiki health report. |
| `status <vault>` | Vault diagnostics. |
| `audit <file>` | Citation marker + sources↔body consistency. |
| `fetch-guard <url>` | URL preflight (Layer 1 security). |
| `query <text>` | Score typed pages; `--include-pending` adds a separate unranked pending-evidence channel. |
| `sources pending <vault>` | List captured articles/papers not yet integrated into typed knowledge. |
| `sources disposition <raw-path>` | Record append-only editorial status for one exact active raw source. |
| `sources dispose <raw-path>` | Preview/attended-apply exceptional permanent disposal for one exact raw object. |
| `graph` | Wikilink adjacency + Adamic-Adar table. |
| `overlap <vault>` | Source-overlap clusters. |
| `orphans <vault>` | Orphan + bridge node detection. |
| `drift <vault>` | Detect raw source drift via sha256 comparison. |
| `dedup <vault>` | Detect duplicates; approved apply rewires maintained citations and preserves duplicate bytes under `raw/duplicates/`. |
| `archive <page>` | Archive typed pages, or dry-run/approved preserve-move exact raw sources under `raw/archived/`. |
| `remove <page>` | Remove maintained pages with durable delete intent; raw targets are refused in favor of `sources dispose`. |
| `claim <transcript>` | Claim a transcript by creating a work item with an exact `source:` path. Rejects `--project` that contradicts the capture's explicit project. |
| `claims audit [vault]` | Read-only transcript claim-integrity report: duplicates, malformed or dangling refs, project mismatches, and unbacked `work_item` metadata. |
| `config` | Manage skillwiki configuration and wiki profiles. |
| `doctor` | Diagnose setup issues (paths, env, plugin, sync health). |
| `path` | Resolve vault or project paths. |
| `lang` | Detect vault language from SCHEMA.md. |
| `pagesize <vault>` | Report page sizes, flag oversized pages. |
| `stale <vault>` | List stale transcripts and incomplete work items. `--project` uses exact normalized project slugs, not substring matching. |
| `links <vault>` | Wikilink graph analysis. |
| `log-rotate <vault>` | Rotate log.md when it exceeds size limit. |
| `log-append <vault>` | Append a vault log entry under an advisory lock. |
| `migrate-citations <vault>` | Convert legacy citation markers to current format. |
| `frontmatter-fix <vault>` | Auto-fix common frontmatter issues. |
| `tag-audit <vault>` | Audit tag taxonomy compliance. |
| `tag reconcile [vault]` | Preview or add prospective typed-page tags to the taxonomy. |
| `page publish <draft> [vault]` | New typed-page write path: publish schema, page, index, and log transactionally. |
| `tag-sync <vault>` | Mirror frontmatter enum values to nested Obsidian tags. |
| `topic-map-check <vault>` | Validate topic map consistency. |
| `index-check <vault>` | Validate index.md entries. |
| `index-link-format <vault>` | Fix index link format issues. |
| `project-index <slug>` | Build project workspace knowledge index. |
| `compound` | Promote retros and list compound entries. |
| `sync` | Vault git sync helpers. |
| `backup` | S3-compatible remote backup sync/restore. |
| `seed <vault>` | Populate a new vault with example content. |
| `observe <vault>` | Create raw transcript observation entry. |
| `session-brief <vault>` | Render or refresh the bounded startup session brief. |
| `memory` | Inspect derived agent memory caches. |
| `ingest <source>` | Ingest a URL or local file into the vault. |
| `fleet` | Fleet topology validate/context/health. |
| `canvas` | Generate and manage Obsidian Canvas files. |
| `transcripts <vault>` | Scan raw/transcripts for new ad-hoc captures. |
| `update` | Check for skillwiki updates from npm. |
| `self-update` | Update skillwiki CLI from local source or npm dist-tag. |
| `mcp` | Optional read-only stdio MCP server (`skillwiki-mcp`). |

All subcommands emit JSON by default. Pass `--human` for terminal output.
`tag reconcile` and `page publish` default to dry-run; add `--write` only after
their preview succeeds. `page publish` is the required write path for new or
updated typed knowledge pages.

Raw evidence is immutable after capture. The CLI may create new captures and,
through attended state-bound workflows, preserve-move exact bytes within
`raw/`; it never rewrites raw content/frontmatter. `raw/assets/**` is a flexible
stable pool: use explicit embeds such as `![[raw/assets/example/diagram.png]]`,
and do not move referenced assets as a side effect of archive or dedup.

## MCP Server (optional, read-only)

`skillwiki mcp` / `skillwiki-mcp` is an optional stdio MCP server over deterministic CLI functions. It is **not** auto-started by the plugin. Mutations stay on the CLI; compile claim/publish/review writes are interactive CLI only.

Read-only tools include query, lint summary, doctor, graph build, project index, stale, config get, **sources pending**, **compile status**, and **reviews**.

Example client config:

```json
{
  "mcpServers": {
    "skillwiki": {
      "command": "skillwiki",
      "args": ["mcp"]
    }
  }
}
```

## Development

```bash
npm install
npm run materialize:plugins:check
npm run test:plugin-metadata
npm run -w skillwiki build
npm test
npm run typecheck
```

Local CLI tarball (for scp / offline install) goes to a **gitignored** folder — never
next to `packages/cli/package.json`:

```bash
npm run pack:cli                 # build + pack → artifacts/npm/skillwiki-<ver>.tgz
npm run pack:cli -- --no-build   # pack only
npm run pack:cli -- --json       # machine-readable path + sha256
```

Requires Node ≥ 20.

## HTTP MCP daemon

`packages/mcp-server` is a Streamable HTTP MCP daemon: the only agent writer
to the SkillWiki vault. It holds a local plain working directory, serializes
Tier-1 writes (`wiki_capture`, `wiki_log_append`), and fail-closes on S3 put
errors. GitHub backup stays a sibling `wiki-snapshot` unit — never inside this
process.

Phase 1 ships the package, Coolify compose files, and image workflow only.
Dev/test deploy is native systemd on sg01 (`wiki.karldigi.dev/mcp`) in a later
phase; fleet Coolify consumes `docker-compose.coolify.yml` (MCP only, S3
endpoint env → existing SeaweedFS). `docker-compose.coolify-bundled.yml` is the
fresh-install template (MCP + hardened SeaweedFS) and is smoke-booted on every
release tag.

Clients use `type: http` with `Authorization: Bearer ${SKILLWIKI_MCP_TOKEN}`.
The server stores `sha256(token) → host_id` in a token map (hashes only). Token
mint is a host operation at first deploy, not this repo — see
`projects/llm-wiki/work/2026-09-12-centralized-wiki-http-mcp/plan.md` §5.

### Grok plugin (HTTP MCP captures)

The SkillWiki Grok plugin ships `mcp.json` / `.mcp.json` pointing at
`https://wiki.karldigi.dev/mcp`. Captures use MCP `wiki_capture` /
`wiki_log_append` (skill `skillwiki-mcp`); do not write local
`raw/transcripts/` for those captures.

1. Mint a bearer on sg01 (`token_hash → host_id` in the daemon token map). Never
   commit the raw token.
2. `export SKILLWIKI_MCP_TOKEN="<token>"` in the Grok process environment.
   Optional: `SKILLWIKI_MCP_URL` to override the production URL.
3. `grok plugin update skillwiki`
4. Start a **new** session (SessionStart cannot inject the parent MCP env).
5. `grok mcp doctor skillwiki`

**Cursor / Grok Bot:** the Cursor-native package (`.cursor-plugin`) requires
`SKILLWIKI_MCP_TOKEN` and pins `https://wiki.karldigi.dev/mcp` (absolute URL, no
`${VAR:-default}`). Open **Plugins → Configure** for `skillwiki` and enter the
bearer — the same field grok-search uses for `GROK_SEARCH_MCP_TOKEN`. Grok Bot
does not read `~/.cursor/mcp.json` or the Mac process environment. Start a
**new** Agent chat after Configure. Do not rempin unless the llm-wiki gitRef is
stale.

Cursor headless wrappers may copy `cursor-cli-mcp.example.json`; it is not a
marketplace pin and is not auto-installed. Fail closed if the token is missing.
Never put the bearer in plugin files or the wiki.

## Spec

The archive-only canonical specification lives under the active SkillWiki vault at
`{WIKI_PATH}/projects/llm-wiki/history/specs/2026-05-02-llm-wiki-skill-design.md`
(revised 2026-05-03). Resolve `{WIKI_PATH}` with `skillwiki path`.
