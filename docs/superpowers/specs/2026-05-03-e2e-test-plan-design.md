# E2E Test Plan: skillwiki v0.2.0-beta.1

**Date:** 2026-05-03
**Scope:** End-to-end smoke testing across two environments before npm beta publish.

## Environments

| | macOS (local) | sg01 (Debian remote) |
|---|---|---|
| **Access** | Direct | SSH with key |
| **Node.js** | 20+ | 20+ |
| **Obsidian** | Desktop installed (not used) | None needed |
| **Hermes** | No | Yes — installed |
| **CLI source** | Local build (`packages/cli/dist/cli.js`) | `npm install -g skillwiki@0.2.0-beta.1` |
| **Plugin test** | Yes (`/plugin install skillwiki@llm-wiki`) | No (no Claude Code) |

## Approach

Sequential bash smoke scripts per environment. Shared assertion helpers. Manual execution with live output. No test framework overhead.

**Why bash over vitest:** Beta release validation — need to see output live, inspect files, catch UX issues. Can promote to vitest harness later.

## Commands Under Test

Core user-facing commands + plugin channel:

| Command | What to verify |
|---|---|
| `init` | Scaffolds 11 dirs, 3 files, writes `.env`, Hermes fallback on sg01 |
| `lint` | Aggregator: severity bucketing, exit codes 0/22/23 |
| `links` | Finds broken wikilinks, exit 16 |
| `orphans` | Finds orphan + bridge nodes, exit 0 (orphans = warning) |
| `tag-audit` | Detects tags not in taxonomy, exit 17 |
| `index-check` | Missing/ghost index entries, exit 18 |
| `stale` | Detects stale pages, exit 19 |
| `pagesize` | Detects oversized pages, exit 20 |
| `log-rotate` | Detects rotation need, exit 21; `--apply` actually rotates |
| `path` | Resolution chain (flag > env > dotenv > Hermes > default), `--explain` |
| `lang` | Resolution chain + alias normalization (`chinese-traditional` → `zh-Hant`), `--explain` |
| `install` | `--dry-run` reports 10 skills; full install copies all + manifest + backup |
| Plugin channel | `/plugin install skillwiki@llm-wiki` shows 10 skills (macOS only) |

## Sample Vault Data

After `init`, the script programmatically seeds 8 test files:

| File | Frontmatter | Body | Lint check hit |
|---|---|---|---|
| `entities/valid-entity.md` | Valid, all required fields | Links to `valid-concept` | Baseline pass |
| `concepts/valid-concept.md` | Valid, all required fields | Links to `valid-entity` | Baseline pass |
| `entities/orphan-entity.md` | Valid | No wikilinks in or out | `orphans` (warning) |
| `concepts/broken-link.md` | Valid | `[[nonexistent-page]]` | `broken_wikilinks` (error) |
| `entities/bad-tag.md` | Valid but tag `not-in-taxonomy` | Normal | `tag_not_in_taxonomy` (error) |
| `concepts/stale-page.md` | `updated` 120 days ago, raw source ingested recently | Normal | `stale_page` (warning) |
| `entities/big-page.md` | Valid | 250+ lines | `page_too_large` (warning) |
| `meta/log.md` | Modified post-init | 600+ entries | `log_rotate_needed` (warning) |

## Script Structure

### `scripts/e2e-common.sh` — Shared helpers

```bash
assert_exit <expected> <actual> <label>
assert_json_contains <field> <value> <label>
assert_file_exists <path> <label>
seed_vault <vault_dir>
summary  # prints pass/fail totals
```

### `scripts/e2e-local.sh` — macOS

```
1. Setup: mktemp for vault, mktemp for HOME (install isolation)
2. Build: npm run -w packages/cli build
3. init --target $VAULT --domain "E2E Test" --taxonomy "research,concept,tool" --lang en
4. Assert: 11 dirs, 3 files, ~/.skillwiki/.env
5. seed_vault $VAULT
6. lint $VAULT → expect exit 23 (has errors)
7. links $VAULT → expect exit 16
8. orphans $VAULT → expect exit 0, JSON contains orphan
9. tag-audit $VAULT → expect exit 17
10. index-check $VAULT → expect exit 18, reports missing_from_index
11. stale $VAULT --days 90 → expect exit 19
12. pagesize $VAULT --lines 200 → expect exit 20
13. log-rotate $VAULT → expect exit 21
14. log-rotate $VAULT --apply → verify rotation happened
15. path --vault $VAULT --explain → verify chain
16. lang --lang chinese-traditional --explain → verify zh-Hant
17. install --dry-run → expect 10 skills reported, no files
18. install (with temp HOME) → expect 10 files + manifest
19. Plugin: /plugin install skillwiki@llm-wiki (manual)
20. Cleanup
```

### `scripts/e2e-remote.sh` — sg01

```
1. Setup: mktemp for vault, mktemp for HOME
2. Install: npm install -g skillwiki@0.2.0-beta.1
3. Hermes compat: backup ~/.hermes/.env, write test one with WIKI_PATH
4. init (no --target) → expect to read from ~/.hermes/.env, imported_from_hermes: true
5. Assert: Hermes fallback worked
6. Restore ~/.hermes/.env
7. seed_vault $VAULT
8. lint → links → orphans → tag-audit → index-check → stale → pagesize → log-rotate (same as local)
9. path --explain → verify chain includes hermes fallback
10. lang --explain → verify alias resolution
11. install with temp HOME → expect 10 files + manifest
12. Cleanup
```

## Assertions & Pass Criteria

Every command test checks:
1. **Exit code** matches expected value
2. **JSON output** parses and contains expected fields (`ok`, `data` or `error`)
3. **`--human` flag** changes output format but does NOT alter exit code (N2 convention)

### Specific pass criteria

- **`init`**: All 11 directories exist, SCHEMA.md/index.md/log.md exist, `~/.skillwiki/.env` has correct WIKI_PATH and WIKI_LANG
- **`lint`**: Exit 23 (has errors), data contains `errors` array with broken_wikilinks and tag_not_in_taxonomy, `warnings` array with stale/orphan/oversized/log-rotate
- **`orphans`**: Exit 0, JSON contains orphan-entity in orphans list
- **`links`**: Exit 16, JSON lists `nonexistent-page` as broken
- **`path --explain --vault $VAULT`**: chain array shows flag matched
- **`lang --explain --lang chinese-traditional`**: canonical is `zh-Hant`, source is `flag`
- **`install --dry-run`**: reports 10 skills, no files written to target
- **`install`**: 10 SKILL.md files copied, wiki-manifest.json written with installed_at and version
- **Hermes compat (sg01)**: `init` returns `imported_from_hermes: true`, vault created at Hermes-configured path

## Out of Scope

- Utility commands: `hash`, `fetch-guard`, `validate`, `graph`, `overlap`, `audit` — not primary user-facing flows
- Performance/load testing
- Obsidian Desktop integration (vault is just markdown on disk)
- CI integration (manual execution for beta validation)
