# Hermes-Parity for `wiki-init` and `wiki-lint` — Design Specification

**Date**: 2026-05-03
**Status**: Approved for plan generation
**Supersedes**: nothing (additive to `2026-05-02-llm-wiki-skill-design.md`; does not modify N1–N18)
**Repo**: `/Users/karlchow/Desktop/code/llm-wiki`
**Hermes reference**: `raw/hermes-llm-wiki-SKILL-v2.1.0.md`

## TL;DR

Close two parity gaps with the upstream Hermes `llm-wiki` v2.1.0 SKILL while staying inside the v1 normative envelope, and add one skillwiki-only configuration axis (output language):

1. **Onboarding parity** — add a `skillwiki init` subcommand that does a domain-aware vault scaffold, including a tag taxonomy seeded into `SCHEMA.md`, with a Hermes-import reconciliation step persisted to `~/.skillwiki/.env`.
2. **Lint parity** — add 7 missing health checks (broken wikilinks, tag-vs-taxonomy, filesystem↔index reconciliation, stale content, page size, log rotation), and an umbrella `skillwiki lint` that runs all checks in one vault scan and returns a severity-grouped report.
3. **Output language configuration** — `WIKI_LANG` (BCP 47, default `en`) drives the language of generated page prose. Persisted alongside `WIKI_PATH` in `~/.skillwiki/.env`. Structural elements (frontmatter keys, schema headers, log format) stay English to preserve parser and Hermes wire-compat.

Skills remain prompt-only; CLI does no LLM calls (preserves N5). Existing exit codes are not reassigned (preserves the v1 line stability rule). Hermes wire-compat preserved.

## Decisions (locked from brainstorm)

1. **Scope**: both init and lint, full Hermes parity in one round.
2. **Init style**: new `skillwiki init` subcommand (CLI deterministic, skill prompt drives the conversation).
3. **Taxonomy storage**: fenced YAML block inside `SCHEMA.md`. Hermes wire-compat preserved (Hermes treats SCHEMA.md as illustrative prose).
4. **Lint shape**: small focused subcommands (`links`, `tag-audit`, `index-check`, `stale`, `pagesize`, `log-rotate`) plus one umbrella `lint` that fans out and groups findings by severity.
5. **`log-rotate`**: warn-only by default; `--apply` mutates. Lint stays read-only.
6. **Runtime fallback to `~/.hermes/.env`**: dropped. If no vault is configured at runtime, the resolver errors out with a `NO_VAULT_CONFIGURED` exit code that points the user at `skillwiki init`. Hermes is consulted **only** at `init` time, where its value is auto-imported and persisted.
7. **Process env vs. dotenv priority**: process env beats dotenv (conventional).
8. **Init against an existing populated `~/.skillwiki/.env`**: fails with `ENV_WRITE_CONFLICT` unless `--force`.
9. **`init --write-env` flag dropped**: init always writes `~/.skillwiki/.env` (idempotent on same value, error on conflict).
10. **Output language as a configured axis**: `WIKI_LANG` is a BCP 47 tag (default `en`); persisted in `~/.skillwiki/.env`; resolution chain mirrors `WIKI_PATH` minus the Hermes-import step (Hermes does not define this concept). Structural elements (frontmatter keys, schema section headers, index/log format) MUST remain English regardless of `WIKI_LANG`; only page-body prose follows the configured language.

## Scope

### In this round
- New `skillwiki init` subcommand with domain + taxonomy + Hermes-import reconciliation + language reconciliation.
- New `skillwiki path` subcommand exposing the path resolution chain.
- New `skillwiki lang` subcommand exposing the language resolution chain (with alias normalization).
- Six new lint subcommands: `links`, `tag-audit`, `index-check`, `stale`, `pagesize`, `log-rotate`.
- New umbrella `skillwiki lint` subcommand.
- Rewrite of `templates/SCHEMA.md` to Hermes-parity prose with three substitution slots (`{{DOMAIN}}`, `{{TAXONOMY_YAML}}`, `{{WIKI_LANG}}`).
- Update of `wiki-init` and `wiki-lint` SKILL prompts; light update to other `wiki-*` SKILLs to add an explicit "When This Skill Activates" section, a step-0 path/lang resolution call, and an output-language preamble.
- Vitest coverage for every new command, every utility, every parser, and a Hermes wire-compat smoke test on the rendered vault.

### Out of scope
- Any change to `proj-*` skills (they piggyback on the resolved vault).
- Any change to existing `audit`, `validate`, `hash`, `fetch-guard`, `graph`, `overlap`, `install` behavior or exit codes.
- Migration of any existing vault content.
- MCP server work.

## Architecture

```
+---------------------+        +-----------------------------+
|  wiki-* SKILL.md    |  step0 |  skillwiki path             |
|  (prompt-only)      |------->|  (resolves WIKI_PATH chain) |
+----------+----------+        +--------------+--------------+
           |                                  |
           |                                  v
           |                       +-----------------------+
           |                       |  utils/wiki-path.ts   |
           |                       |  utils/dotenv.ts      |
           |                       +-----------+-----------+
           v                                   ^
+---------------------+                        |
|  skillwiki init     |  reads/writes  --------+
|  skillwiki lint     |
|  skillwiki links    |
|  skillwiki tag-audit|
|  skillwiki index-   |
|     check           |
|  skillwiki stale    |
|  skillwiki pagesize |
|  skillwiki log-     |
|     rotate          |
+----------+----------+
           |
           v
+----------------------------+
|  vault/                    |
|    SCHEMA.md  index.md     |
|    log.md  raw/  ...       |
+----------------------------+
```

All new CLI work threads through one shared resolver utility (`utils/wiki-path.ts`); skill prompts call `skillwiki path` once at orientation and `skillwiki <command>` for the actual work.

## Wiki path resolution

### Init-time chain (used only by `skillwiki init` to pick a target when `--target` is omitted)

| # | Source | Notes |
|---|---|---|
| 1 | `--target <dir>` | Explicit override. |
| 2 | process env `WIKI_PATH` | Per-shell override. |
| 3 | `~/.skillwiki/.env` → `WIKI_PATH=…` | Already-adopted skillwiki binding. |
| 4 | `~/.hermes/.env` → `WIKI_PATH=…` | **Hermes import** (one-time, at init only). |
| 5 | `$HOME/wiki` | Default. |

### Runtime chain (used by all other subcommands when `--vault` is omitted)

| # | Source | Notes |
|---|---|---|
| 1 | `--vault <dir>` | Explicit override. |
| 2 | process env `WIKI_PATH` | Per-shell override. |
| 3 | `~/.skillwiki/.env` → `WIKI_PATH=…` | Durable binding written by `init`. |
| — | (no Hermes fallback at runtime — see Decision 6) | |
| → | **Error** `NO_VAULT_CONFIGURED` | Message: "No vault configured. Run `skillwiki init` to bootstrap one, or pass `--vault <dir>`." |

The runtime resolver returns `Result<{ path: string; source: 'flag'|'env'|'skillwiki-dotenv' }>` or fails closed with `NO_VAULT_CONFIGURED`. The init-time resolver always succeeds (default fallback applies).

### `skillwiki path` subcommand

- Signature: `skillwiki path [--explain] [--init-time]`
- Default JSON: `{ ok: true, data: { path: "/abs/path", source: "skillwiki-dotenv" } }`
- `--explain`: adds a `chain` array showing every source checked and whether it matched (debugging aid).
- `--init-time`: switch to the init-time chain (used by `wiki-init` SKILL.md to preview what `init` would pick before it runs).
- `--human`: adds a one-line header `vault: /abs/path (from skillwiki-dotenv)`. Does not alter exit code (N2).
- Exit codes: `0` on success; `NO_VAULT_CONFIGURED` (code 25) at runtime when chain misses; `0` always with `--init-time` (default fallback applies).

### Dotenv parser (zero-dep, internal)

`utils/dotenv.ts`:
- Accepts only `KEY=VALUE` lines.
- Ignores blank lines and lines starting with `#`.
- No quoting, escaping, multi-line, interpolation.
- Whitelisted keys: `WIKI_PATH`, `WIKI_LANG`. Everything else is silently dropped (keeps the file purpose narrow).
- Unreadable file (missing, permission denied) → returns empty map; never throws.

## Wiki output language

A second configuration axis driving the language of generated page prose. Skillwiki-only — no Hermes equivalent.

### Resolution chain (same at init time and runtime — language always has a default)

| # | Source | Notes |
|---|---|---|
| 1 | `--lang <code>` | Per-command override. |
| 2 | process env `WIKI_LANG` | Per-shell override. |
| 3 | `~/.skillwiki/.env` → `WIKI_LANG=…` | Durable binding written by `init`. |
| 4 | `en` | Default. |

The resolver returns `{ value: string; source: 'flag'|'env'|'skillwiki-dotenv'|'default'; canonical: string }`.

### Alias normalization

`utils/lang.ts` provides `normalizeLang(input: string): string`. Case-insensitive. Whitespace trimmed. Specific aliases:

| Input (any case) | Canonical output |
|---|---|
| `english`, `en` | `en` |
| `chinese-traditional`, `zh-hant`, `zh-tw` | `zh-Hant` |
| `chinese-simplified`, `zh-hans`, `zh-cn` | `zh-Hans` |
| anything else | input as-is (BCP 47 is permissive; we don't reject) |

The canonical form is what's written to `~/.skillwiki/.env`, what's emitted in JSON output, and what skill prompts reference.

### What `WIKI_LANG` affects

- **Yes** — page body prose, narrative sections of entities/concepts/comparisons/queries, lint report `--human` output, log entry free-text descriptions.
- **No** — frontmatter keys (`title:`, `tags:`, `sources:`, `provenance:`, etc.), file names, SCHEMA.md section headers (`## Domain`, `## Tag Taxonomy`, …), index.md section names (`## Entities`, `## Concepts`, …), log entry format prefix (`## [YYYY-MM-DD] action |`), citation markers (`^[raw/...]`), wikilink slugs.

This split is the parser/wire-compat firewall. Hermes parsers and our CLI parsers both depend on the structural elements being English.

### `skillwiki lang` subcommand

- Signature: `skillwiki lang [--explain]`
- Default JSON: `{ ok: true, data: { value: "zh-Hant", source: "skillwiki-dotenv", canonical: "zh-Hant" } }`
- `--explain`: adds a `chain` array showing every source checked.
- `--human`: adds `lang: zh-Hant (from skillwiki-dotenv)` header. Does not alter exit code (N2).
- Exit codes: always `0` (default fallback applies).

## `skillwiki init` subcommand

### Signature

```
skillwiki init
    [--target <dir>]
    --domain "<text>"
    [--taxonomy a,b,c,...]
    [--lang <bcp47>]
    [--force]
```

### Behavior

1. Resolve target via the **init-time path chain** above.
2. Resolve language via the **language chain** above (`--lang` → env → skillwiki-dotenv → `en`). Normalize via alias table.
3. Verify target is empty or contains no `SCHEMA.md`. If not, fail with `INIT_TARGET_NOT_EMPTY` (code 15) unless `--force` is also passed.
4. Create the vault tree:
   ```
   raw/{articles,papers,transcripts,assets}/
   entities/  concepts/  comparisons/  queries/  meta/  projects/
   ```
5. Render `SCHEMA.md` from the new template, substituting `{{DOMAIN}}`, `{{TAXONOMY_YAML}}`, and `{{WIKI_LANG}}`. If `--taxonomy` is omitted, use the default 10-tag generic taxonomy:
   ```
   research, comparison, timeline, summary, person,
   organization, concept, technique, tool, model
   ```
6. Render `index.md` from template, substituting `{{INIT_DATE}}` (today's date in `YYYY-MM-DD`).
7. Render `log.md` from template, substituting `{{INIT_DATE}}`, `{{DOMAIN}}`, and `{{WIKI_LANG}}` into the structured initialization entry (`## [YYYY-MM-DD] create | Wiki initialized` with bullets `Domain: <domain>`, `Output language: <lang>`, and `Structure created with SCHEMA.md, index.md, log.md`).
8. **Reconcile `~/.skillwiki/.env`** (both keys, atomic):
   - For each of `WIKI_PATH=<resolved-target>` and `WIKI_LANG=<canonical-lang>`:
     - File missing or key absent → create the directory if needed; write the line.
     - Key present with same value → no-op.
     - Key present with different value → fail with `ENV_WRITE_CONFLICT` (code 24) unless `--force`.
   - On `--force`, both keys are rewritten to the resolved values.
9. Return JSON envelope:
   ```json
   {
     "ok": true,
     "data": {
       "vault": "/abs/path",
       "domain": "...",
       "taxonomy": ["..."],
       "lang": "zh-Hant",
       "created": ["SCHEMA.md", "index.md", "log.md", "raw/", ...],
       "env_written": "/Users/x/.skillwiki/.env",
       "imported_from_hermes": true
     }
   }
   ```

`imported_from_hermes` is `true` iff (a) the resolved target came from `~/.hermes/.env` (chain level 4) AND (b) `~/.skillwiki/.env` did not previously contain `WIKI_PATH` (so step 8 wrote a new line). In every other case it is `false`. (Language is never imported from Hermes — Hermes does not define `WIKI_LANG`.)

### Exit codes

- `0` (OK) on success
- `15` `INIT_TARGET_NOT_EMPTY`
- `24` `ENV_WRITE_CONFLICT`
- existing `WRITE_FAILED` (10) for filesystem failures during scaffolding

## Templates

### `templates/SCHEMA.md` (rewritten)

```markdown
# Vault Schema

## Domain

{{DOMAIN}}

## Output Language

{{WIKI_LANG}}

This sets the language of generated page prose. Frontmatter keys, schema section headers, file names, and log/index structural lines remain English (parser and Hermes wire-compat invariant).

## Layers

- `raw/` — immutable source material (never modify after ingest).
- `entities/`, `concepts/`, `comparisons/`, `queries/` — typed knowledge unified across origin via `provenance:`.
- `meta/` — cross-project synthesis (notes naming ≥2 projects).
- `projects/{slug}/` — per-project lifecycle workspace.

## Frontmatter

Four shapes: typed-knowledge, raw, work-item, compound. See spec for full Zod schemas.

## Tag Taxonomy

~~~yaml
taxonomy:
{{TAXONOMY_YAML}}
~~~

(In the actual template file, the fence is triple backticks; rendered here with `~~~` only because this spec is itself a fenced markdown block.)

Rule: every tag on every page MUST appear in this taxonomy. Add new tags here first, then use them.

## Page Thresholds

- Create a page when an entity/concept appears in 2+ sources OR is central to one source.
- Add to an existing page when overlap with covered material.
- DO NOT create a page for passing mentions.
- Split a page when it exceeds ~200 lines.
- Archive a page when fully superseded — move to `_archive/`, remove from `index.md`.

## Update Policy

- Newer sources generally supersede older ones (compare dates).
- Genuine contradictions: note both positions with dates and sources.
- Mark in frontmatter: `contested: true` and `contradictions: [other-page]`.
- Flag for user review during lint.

## Conventions

- File names: lowercase-hyphenated, no spaces.
- Wikilinks in YAML: quoted, `"[[name]]"`. Body wikilinks: unquoted `[[name]]`.
- Citations in body: `^[raw/...]` markers; every entry in `sources:` MUST appear in body.
- sha256 in `raw/` frontmatter is computed by `skillwiki hash` over body bytes after closing `---`.
```

`{{TAXONOMY_YAML}}` is rendered as a YAML array body (one `- name` per line, two-space indent). Example for `--taxonomy "model,architecture,benchmark"`:

```yaml
  - model
  - architecture
  - benchmark
```

### `templates/index.md` (extended)

```markdown
# Vault Index

> Last updated: {{INIT_DATE}} | Total pages: 0

## Entities
<!-- entities listed here -->

## Concepts
<!-- concepts listed here -->

## Comparisons
<!-- comparisons listed here -->

## Queries
<!-- queries listed here -->

## Projects
<!-- registered projects listed here -->

## Meta
<!-- cross-project synthesis listed here -->
```

### `templates/log.md` (extended)

```markdown
# Vault Log

Chronological action log. Newest entries last. Skill writes append entries; lint may rotate.

## [{{INIT_DATE}}] create | Wiki initialized

- Domain: {{DOMAIN}}
- Output language: {{WIKI_LANG}}
- Structure created with SCHEMA.md, index.md, log.md
```

## `wiki-init` SKILL.md (rewritten)

```
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
```

## New lint subcommands

All take an optional `<vault>` positional; absent → use the runtime resolver.

### `skillwiki links <vault>`

For every `[[wikilink]]` in the body of every typed-knowledge page, verify the target slug resolves to an existing page in the vault.

- JSON: `{ ok: true, data: { broken: [{ page, slug, line }, ...] } }`
- Exit: `0` clean, `BROKEN_WIKILINKS` (code 16) if any.

### `skillwiki tag-audit <vault>`

Read taxonomy from `SCHEMA.md`'s fenced YAML block. For every typed-knowledge page, every entry in its `tags:` MUST appear in the taxonomy.

- JSON: `{ ok: true, data: { violations: [{ page, tag }, ...], taxonomy: [...] } }`
- Exit: `0` clean, `TAG_NOT_IN_TAXONOMY` (code 17) if any violation, `INVALID_FRONTMATTER` (existing) if SCHEMA.md taxonomy block is malformed or absent.

### `skillwiki index-check <vault>`

Compare typed-knowledge filesystem against `index.md`:
- Every typed-knowledge file MUST appear in some section of `index.md`.
- Every wiki-link in `index.md` MUST resolve to a real file.

- JSON: `{ ok: true, data: { missing_from_index: [...], ghost_entries: [...] } }`
- Exit: `0` clean, `INDEX_INCOMPLETE` (code 18) if any.

### `skillwiki stale <vault> [--days 90]`

For every typed-knowledge page with `sources:`, find the newest cited raw page's `ingested:` date. If page `updated:` is more than `--days` (default 90) older, flag.

- JSON: `{ ok: true, data: { stale: [{ page, page_updated, newest_source_ingested, gap_days }, ...] } }`
- Exit: `0` clean, `STALE_PAGE` (code 19) if any.

### `skillwiki pagesize <vault> [--lines 200]`

Flag typed-knowledge pages with body longer than `--lines` (default 200) lines.

- JSON: `{ ok: true, data: { oversized: [{ page, lines }, ...] } }`
- Exit: `0` clean, `PAGE_TOO_LARGE` (code 20) if any.

### `skillwiki log-rotate <vault> [--threshold 500] [--apply]`

Count entries in `log.md` (lines matching `^## \[\d{4}-\d{2}-\d{2}\]`). If `≥ threshold`:

- Default (no `--apply`): warn-only. Exit: `LOG_ROTATE_NEEDED` (code 21).
- With `--apply`: rename `log.md` → `log-YYYY.md` (year of the most recent entry); write a fresh `log.md` with header and one structured `## [<today>] rotate | Log rotated from N entries` entry. Exit `0`.

JSON: `{ ok: true, data: { entries: N, threshold: T, rotated: true|false, rotated_to?: "log-YYYY.md" } }`

## `skillwiki lint` umbrella subcommand

### Signature

```
skillwiki lint [<vault>] [--days 90] [--lines 200] [--log-threshold 500]
```

### Behavior

Single vault scan. Runs all checks (existing + new) using shared parsed page structures. Returns:

```json
{
  "ok": true,
  "data": {
    "vault": { "path": "/abs/path", "source": "skillwiki-dotenv" },
    "summary": { "errors": N, "warnings": N, "info": N },
    "by_severity": {
      "error": [
        { "kind": "broken_wikilinks", "items": [...] },
        { "kind": "invalid_frontmatter", "items": [...] },
        { "kind": "raw_drift", "items": [...] },
        { "kind": "tag_not_in_taxonomy", "items": [...] }
      ],
      "warning": [
        { "kind": "index_incomplete", "items": [...] },
        { "kind": "stale_page", "items": [...] },
        { "kind": "page_too_large", "items": [...] },
        { "kind": "log_rotate_needed", "items": [...] },
        { "kind": "contested", "items": [...] },
        { "kind": "orphans", "items": [...] }
      ],
      "info": [
        { "kind": "bridges", "items": [...] },
        { "kind": "low_confidence_single_source", "items": [...] }
      ]
    }
  }
}
```

### Exit codes

- `0` when clean (no findings at any severity).
- `LINT_HAS_WARNINGS` (code 22) when there are warning/info findings only.
- `LINT_HAS_ERRORS` (code 23) when there is at least one error finding.
- `--human` does not alter exit codes (N2).

### Severity ordering (in `by_severity` arrays and in `--human` output)

Errors: `broken_wikilinks` → `invalid_frontmatter` → `raw_drift` → `tag_not_in_taxonomy`.
Warnings: `index_incomplete` → `stale_page` → `page_too_large` → `log_rotate_needed` → `contested` → `orphans`.
Info: `bridges` → `low_confidence_single_source`.

## `wiki-lint` SKILL.md (rewritten)

```
---
name: wiki-lint
description: Vault health check via the umbrella `skillwiki lint` subcommand. Read-only by default; rotation requires explicit user consent.
---

# wiki-lint

## When This Skill Activates

- User asks for a vault health report, lint, or audit.
- Periodic maintenance.

## Pre-orientation reads

Standard four reads.

## Steps

0. Resolve vault: `skillwiki path` (record source for context).
1. Run `skillwiki lint <vault>`. Read the JSON.
2. Reason over findings; present grouped by severity with concrete suggested actions per kind.
3. If `log_rotate_needed` is present and the user consents, run `skillwiki log-rotate <vault> --apply`. Otherwise leave alone.
4. Append one `log.md` entry summarizing the lint counts (errors/warnings/info).

## Stop conditions

None — lint reports all findings even on per-page errors.

## Forbidden

- Auto-rotating logs.
- Auto-updating sha256 fields.
- Modifying any page beyond the lint summary entry in `log.md`.
```

## Other `wiki-*` SKILL.md updates

Each gets a `When This Skill Activates` section (Hermes-style trigger list), a step-0 path/lang resolution, and an output-language preamble:

> **Output language.** Run `skillwiki lang` at the start. Generate page-body prose, narrative sections, and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.

- `wiki-ingest`: triggers on URL/paste/file in research context, when a vault is resolvable.
- `wiki-query`: triggers on a question, when a vault is resolvable.
- `wiki-audit`: triggers on per-page audit ask or pre-merge gate.
- `wiki-crystallize`: existing triggers + path/lang resolution preamble.

The 4 `proj-*` skills are unchanged for v1 of this delta; they inherit the language hint from the same `~/.skillwiki/.env` if and when they are revised in a follow-up. They operate on `projects/{slug}/` paths under whatever vault the wiki-* skills resolved.

## Exit code allocation

Existing 0–14 unchanged. New codes (next-unused integers):

| Code | Name |
|---|---|
| 15 | `INIT_TARGET_NOT_EMPTY` |
| 16 | `BROKEN_WIKILINKS` |
| 17 | `TAG_NOT_IN_TAXONOMY` |
| 18 | `INDEX_INCOMPLETE` |
| 19 | `STALE_PAGE` |
| 20 | `PAGE_TOO_LARGE` |
| 21 | `LOG_ROTATE_NEEDED` |
| 22 | `LINT_HAS_WARNINGS` |
| 23 | `LINT_HAS_ERRORS` |
| 24 | `ENV_WRITE_CONFLICT` |
| 25 | `NO_VAULT_CONFIGURED` |

`packages/shared/src/exit-codes.ts` and its test get appended; existing assertions are not touched.

## File inventory

### New

```
packages/cli/src/utils/wiki-path.ts
packages/cli/src/utils/dotenv.ts
packages/cli/src/utils/lang.ts
packages/cli/src/parsers/taxonomy.ts
packages/cli/src/commands/init.ts
packages/cli/src/commands/path.ts
packages/cli/src/commands/lang.ts
packages/cli/src/commands/links.ts
packages/cli/src/commands/tag-audit.ts
packages/cli/src/commands/index-check.ts
packages/cli/src/commands/stale.ts
packages/cli/src/commands/pagesize.ts
packages/cli/src/commands/log-rotate.ts
packages/cli/src/commands/lint.ts

packages/cli/src/utils/__tests__/wiki-path.test.ts
packages/cli/src/utils/__tests__/dotenv.test.ts
packages/cli/src/utils/__tests__/lang.test.ts
packages/cli/src/parsers/__tests__/taxonomy.test.ts
packages/cli/src/commands/__tests__/init.test.ts
packages/cli/src/commands/__tests__/path.test.ts
packages/cli/src/commands/__tests__/lang.test.ts
packages/cli/src/commands/__tests__/links.test.ts
packages/cli/src/commands/__tests__/tag-audit.test.ts
packages/cli/src/commands/__tests__/index-check.test.ts
packages/cli/src/commands/__tests__/stale.test.ts
packages/cli/src/commands/__tests__/pagesize.test.ts
packages/cli/src/commands/__tests__/log-rotate.test.ts
packages/cli/src/commands/__tests__/lint.test.ts
packages/cli/src/commands/__tests__/wire-compat.test.ts
```

### Modified

```
packages/cli/templates/SCHEMA.md           (full rewrite per template above; adds {{WIKI_LANG}} slot)
packages/cli/templates/index.md            (add header line with Total pages and last updated)
packages/cli/templates/log.md              (add structured init entry placeholder; includes Output language line)
packages/cli/src/cli.ts                    (register init, path, lang, links, tag-audit, index-check, stale, pagesize, log-rotate, lint)
packages/cli/src/commands/orphans.ts       (vault arg becomes optional → use resolver)
packages/shared/src/exit-codes.ts          (append codes 15–25)
packages/shared/src/exit-codes.test.ts     (append assertions for new codes)
packages/skills/wiki-init/SKILL.md         (new flow per spec; asks the language question)
packages/skills/wiki-lint/SKILL.md         (collapse to umbrella call per spec)
packages/skills/wiki-ingest/SKILL.md       (add trigger list + step-0 + output-language preamble)
packages/skills/wiki-query/SKILL.md        (add trigger list + step-0 + output-language preamble)
packages/skills/wiki-audit/SKILL.md        (add trigger list + step-0 + output-language preamble)
packages/skills/wiki-crystallize/SKILL.md  (add trigger list + step-0 + output-language preamble)
```

### Untouched

- `packages/cli/src/commands/{audit,validate,hash,fetch-guard,graph,overlap,install}.ts`
- All four `proj-*` skills.
- `2026-05-02-llm-wiki-skill-design.md` and N1–N18.

## Test plan

### Unit

- `dotenv.test.ts` — parses `KEY=VALUE`, ignores comments and blanks, accepts `WIKI_PATH` and `WIKI_LANG`, drops other keys, missing/unreadable file returns empty map without throwing.
- `wiki-path.test.ts` — init-time and runtime chain priority; `source` label correctness for each level; runtime miss returns `NO_VAULT_CONFIGURED`; unreadable files don't throw.
- `lang.test.ts` (utils) — alias normalization (`chinese-traditional` → `zh-Hant`, case-insensitive, whitespace-trimmed); pass-through for unknown tags; default `en`; chain priority (flag > env > skillwiki-dotenv > default); source labels.
- `taxonomy.test.ts` — extracts the fenced YAML block from a SCHEMA.md fixture; rejects malformed YAML; returns empty list for missing block (caller decides if this is fatal).

### Per-subcommand

- `init.test.ts`
  - empty target succeeds; non-empty fails `INIT_TARGET_NOT_EMPTY`; `--force` overrides.
  - `{{DOMAIN}}`, `{{TAXONOMY_YAML}}`, and `{{WIKI_LANG}}` substituted correctly; default taxonomy applied when flag omitted; default `en` lang applied when `--lang` omitted.
  - `--lang chinese-traditional` normalizes to `zh-Hant` in dotenv and JSON output.
  - `~/.skillwiki/.env` absent → both `WIKI_PATH` and `WIKI_LANG` written; same values → no-op; different `WIKI_PATH` → `ENV_WRITE_CONFLICT`; different `WIKI_LANG` → `ENV_WRITE_CONFLICT`; `--force` overwrites both.
  - Hermes-import path: `~/.hermes/.env` populated, `~/.skillwiki/.env` missing, no `--target` → resolves to Hermes value, writes to skillwiki dotenv, `imported_from_hermes: true` in JSON output. Language is NOT imported from Hermes (Hermes doesn't define `WIKI_LANG`); language falls through to default unless flag/env/skillwiki-dotenv supplies one.
- `path.test.ts` — JSON shape, `--explain` chain, `--init-time` vs runtime difference, `--human` header line.
- `lang.test.ts` (command) — JSON shape, `--explain` chain, alias normalization in output, `--human` header line.
- `links.test.ts` — clean / broken-target / cross-folder / self-reference cases.
- `tag-audit.test.ts` — clean / missing taxonomy block / tag-not-in-taxonomy.
- `index-check.test.ts` — page missing from index / ghost entry in index / clean.
- `stale.test.ts` — gap > threshold flagged; gap ≤ threshold clean; no sources clean.
- `pagesize.test.ts` — over/under threshold; threshold flag respected.
- `log-rotate.test.ts` — under threshold ok; over threshold warns (no file change); `--apply` renames and creates fresh log; second `--apply` is no-op.
- `lint.test.ts` — clean fixture exits 0; warning-only fixture exits `LINT_HAS_WARNINGS`; mixed-severity fixture exits `LINT_HAS_ERRORS` and JSON severity arrays match expected ordering.

### Wire-compat

- `wire-compat.test.ts` — drives `runInit` against a tmp dir, then asserts that the rendered `SCHEMA.md` contains the exact prose section headers Hermes v2.1.0 references (`## Domain`, `## Tag Taxonomy`, `## Page Thresholds`, `## Update Policy`, `## Conventions`), and that `index.md` and `log.md` contain the structural elements Hermes prompts expect (`## [YYYY-MM-DD] create |` line in log; sectioned headers in index). Verify that the new `## Output Language` section is additive (Hermes parsers ignore unknown sections, satisfying N13).

### Existing-suite invariants

- All current tests pass unchanged.
- `exit-codes.test.ts` keeps existing assertions and adds new ones for codes 15–25.

## Definition of Done

- [ ] `skillwiki init` implemented with full Hermes-import reconciliation AND language reconciliation; passes all `init.test.ts` cases including the Hermes-import path and the `chinese-traditional` alias case.
- [ ] `skillwiki path` implemented; both chains tested.
- [ ] `skillwiki lang` implemented; alias normalization tested; resolution chain tested.
- [ ] All 6 small lint subcommands implemented and tested in isolation.
- [ ] `skillwiki lint` umbrella implemented; severity grouping and exit code matrix tested.
- [ ] `templates/SCHEMA.md` rewritten with substitution slots (`{{DOMAIN}}`, `{{TAXONOMY_YAML}}`, `{{WIKI_LANG}}`); rendered output passes wire-compat smoke test.
- [ ] `templates/log.md` includes `Output language:` line in the initialization entry.
- [ ] `wiki-init` and `wiki-lint` SKILL.md files rewritten per spec; other `wiki-*` SKILLs gain trigger lists, step-0, and the output-language preamble.
- [ ] Exit codes 15–25 added to `packages/shared/src/exit-codes.ts` with no reassignment of 0–14; tests updated.
- [ ] `npm run -w packages/cli test` and `npm run -w packages/shared test` both green.
- [ ] N1–N18 still satisfied (manually re-verified against this spec's deltas).
- [ ] No bash scripts; no LLM API calls in CLI (N5).
- [ ] Hermes wire-compat preserved (verified via wire-compat test, including verification that the new `## Output Language` section is additive per N13).

## Traceability

| Decision | Drives |
|---|---|
| 1, 2 | `skillwiki init` + template rewrite |
| 3 | `parsers/taxonomy.ts` + `tag-audit` |
| 4 | small subcommands + `lint` umbrella |
| 5 | `log-rotate` two-mode behavior |
| 6 | runtime resolver fail-closed; `NO_VAULT_CONFIGURED` |
| 7 | resolver ordering test cases |
| 8, 9 | `init` always writes; `ENV_WRITE_CONFLICT` semantics |
| 10 | `utils/lang.ts`, `commands/lang.ts`, `WIKI_LANG` slot in templates, output-language preamble in skills |

| Hermes section | Covered by |
|---|---|
| "When This Skill Activates" | trigger lists in every wiki-* SKILL |
| "Wiki Location" | `utils/wiki-path.ts` + init-time + runtime chains |
| "Initializing a New Wiki" | `skillwiki init` flow |
| "SCHEMA.md Template" | rewritten `templates/SCHEMA.md` |
| "index.md Template" | extended `templates/index.md` |
| "log.md Template" | extended `templates/log.md` |
| "Lint" 1–11 | `links`, `tag-audit`, `index-check`, `stale`, `pagesize`, `log-rotate`, `lint` umbrella + existing `validate`, `hash`, `orphans` |
| (skillwiki extension) | `WIKI_LANG` configuration; `## Output Language` section in SCHEMA.md; output-language preamble in all wiki-* SKILLs |
