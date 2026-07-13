---
name: wiki-ingest
description: Convert URLs, files, or pasted text into typed-knowledge pages with raw provenance. Supports single and batch mode.
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
## Steps (in order — deterministic raw capture and shared publication)
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`. Use the resolved vault path for all writes; use the canonical language for all generated prose.
1. **Guard.** For each URL: run `skillwiki fetch-guard <url>`. If exit ≠ 0, STOP and surface the error. Do not retry.
2. **Fetch.** Use `web_fetch` (or read local file) under Layer 2 controls (the CLI Layer 2 fetcher applies in tests; in skill runtime use `web_fetch` directly and treat any error as STOP).
   - **Portable local-source rule:** follow `using-skillwiki` → Portable Source References. Do not use `source_url: file:///...` as the canonical durable reference; prefer commit-pinned GitHub `blob/<commit>/<path>` when resolvable, else empty `source_url` plus portable repo-relative prose.
3. **Identity guard.** Before writing raw files, ensure the target raw filename/title, `source_url`, fetched H1/title, and early body subject agree. If `skillwiki ingest` reports `INGEST_VALIDATION_FAILED` with `source identity conflict`, STOP. Do not fix by renaming after the fact; choose the correct title/source pair or ask the user.
4. **Sensitive content guard.** Before writing or filing any vault page, scan the source and generated body for live credentials, access keys, tokens, passwords, cookies, bearer headers, or private keys. Redact generated prose before writing. If the source itself must remain raw and contains a live secret, STOP instead of preserving it.
5. **Feature-detect publication.** Run `skillwiki page publish --help`. If unavailable, fail closed and leave typed output unpublished; update the active SkillWiki CLI/plugin channel first.
6. **Ingest and publish.** Use `skillwiki ingest` for deterministic source capture and typed-page publication. The command writes an immutable raw source first and delegates the typed page, taxonomy, index, and structural log entry to the shared page publisher. Supply the resolved vault, type, title, tags, and provenance through the command options.
7. **Recovery.** Never create the final typed page or edit index.md/log.md directly. A raw-only result after publication failure is valid recovery state. Keep the exact command inputs and retry; do not delete or overwrite the raw source.
## Provenance defaults
- Default `provenance: research`.
- If cwd is inside `projects/{slug}/`, set `provenance: project` and add `provenance_projects: ["[[slug]]"]`.
## Raw Data Locality
Raw ephemeral data (market feeds, logs, transient JSON) must be written to the **project local** `raw/` directory, NOT the cloud-mounted wiki path. See `references/raw-data-locality.md` for the full pattern.
**Quick rule:**
- Transient data → `~/projects/{slug}/raw/` (local, git-tracked)
- Compound pages → `~/wiki/projects/{slug}/compound/` (cloud, durable)
## Stop conditions
- `fetch-guard` non-zero.
- Fetch timeout / size limit exceeded.
- `INGEST_VALIDATION_FAILED` with `source identity conflict`.
- Source or generated content contains unredacted live credentials or other authenticating secrets.
- `skillwiki page publish --help` is unavailable.
- `skillwiki ingest` returns nonzero; retain any raw-only result for retry.
- sha256 already exists in vault for the same source.
## Forbidden
- Skipping `fetch-guard`.
- Creating a final typed page or editing `index.md`/`log.md` directly.
- Modifying any existing file in `raw/`.
- Writing raw ephemeral data directly to cloud-mounted wiki paths (`~/wiki/`).
- Writing host-local absolute paths as canonical durable source references (see `using-skillwiki` → Portable Source References).
- Writing `[[wikilinks]]` to pages that don't exist in the vault. Before linking, verify the target exists: check `index.md` or `ls` the target directory. If the target doesn't exist yet, use plain text instead of a wikilink.
## Batch Mode
When the user provides multiple sources (a directory of files, a list of URLs, or a multi-document input):
1. **Loop per source.** Execute steps 1–7 for each source individually, using one `skillwiki ingest` command per source.
2. **Fail fast.** If an ingest command returns nonzero, STOP and report the retained raw-only state, if any, with its exact retry inputs.
3. **Deduplication.** Let `skillwiki ingest` preserve immutable raw capture and skip sources whose content is already present.
4. **Progress.** After each source completes, report the raw path, typed path or recovery state, and publisher operation ID.
