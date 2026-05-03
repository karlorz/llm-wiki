---
name: wiki-ingest
description: Convert URLs, files, or pasted text into typed-knowledge pages with raw provenance. Single-pass v1.
---

# wiki-ingest

## When This Skill Activates

- User shares a URL, paste, or local file to capture in the vault.
- The output target is `entities/`, `concepts/`, `comparisons/`, or `queries/`.
- A vault is resolvable (see step 0).

## Output language

Run `skillwiki lang` at the start. Generate page-body prose, narrative sections, and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.

## Pre-orientation reads (mandatory before any write)
1. `SCHEMA.md`
2. `index.md`
3. Last 20–30 entries of `log.md`
4. (Project context only) `projects/{slug}/README.md` and last ~5 work-item logs.

## Steps (in order — N6, N7, N8)
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`. Use the resolved vault path for all writes; use the canonical language for all generated prose.
1. **Guard.** For each URL: run `npx skillwiki fetch-guard <url>`. If exit ≠ 0, STOP and surface the error. Do not retry.
2. **Fetch.** Use `web_fetch` (or read local file) under Layer 2 controls (the CLI Layer 2 fetcher applies in tests; in skill runtime use `web_fetch` directly and treat any error as STOP).
3. **Hash.** Write the raw file (frontmatter + body). Run `npx skillwiki hash <raw-file>` and embed the result in raw frontmatter `sha256:`.
4. **Generate page(s).** Compose typed-knowledge page(s) with citations pre-attached (`^[raw/...]` markers).
5. **Validate.** For each generated page: run `npx skillwiki validate <page>`. If exit ≠ 0, STOP — do not write index/log.
6. **Apply writes in order.** raw → page(s) → `index.md` → `log.md`.
7. **Confidence flag.** If only one source is cited, set `confidence: low`.

## Provenance defaults
- Default `provenance: research`.
- If cwd is inside `projects/{slug}/`, set `provenance: project` and add `provenance_projects: ["[[slug]]"]`.

## Stop conditions
- `fetch-guard` non-zero.
- Fetch timeout / size limit exceeded.
- `validate` non-zero on any page.
- sha256 already exists in vault for the same source.

## Forbidden
- Skipping `fetch-guard`.
- Updating `index.md` or `log.md` before all pages validate.
- Modifying any existing file in `raw/`.
