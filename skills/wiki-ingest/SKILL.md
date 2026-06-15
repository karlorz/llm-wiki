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
## Steps (in order — N6, N7, N8)
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`. Use the resolved vault path for all writes; use the canonical language for all generated prose.
1. **Guard.** For each URL: run `skillwiki fetch-guard <url>`. If exit ≠ 0, STOP and surface the error. Do not retry.
2. **Fetch.** Use `web_fetch` (or read local file) under Layer 2 controls (the CLI Layer 2 fetcher applies in tests; in skill runtime use `web_fetch` directly and treat any error as STOP).
3. **Identity guard.** Before writing raw files, ensure the target raw filename/title, `source_url`, fetched H1/title, and early body subject agree. If `skillwiki ingest` reports `INGEST_VALIDATION_FAILED` with `source identity conflict`, STOP. Do not fix by renaming after the fact; choose the correct title/source pair or ask the user.
4. **Sensitive content guard.** Before writing or filing any vault page, scan the source and generated body for live credentials, access keys, tokens, passwords, cookies, bearer headers, or private keys. Redact generated prose before writing. If the source itself must remain raw and contains a live secret, STOP instead of preserving it.
5. **Hash.** Write the raw file (frontmatter + body). Run `skillwiki hash <raw-file>` and embed the result in raw frontmatter `sha256:`.
6. **Generate page(s).** Compose typed-knowledge page(s) with citations pre-attached (`^[raw/...]` markers). Every page MUST include:
- `> **TL;DR:**` blockquote as the first content after the title heading — a one-sentence summary of the page's key takeaway (under 200 chars). See SCHEMA.md `## TL;DR Convention`.
- For pages tagged `architecture` or explaining workflows/systems: include a Mermaid diagram (`graph TB` or `sequenceDiagram`) in the body. Follow Obsidian-compatible Mermaid rules (see SCHEMA.md `## Mermaid Diagrams`).
For generated `comparisons/` pages or evaluation-style `queries/` pages, end the body with:
```markdown
## Decision Closeout

Disposition: no-op | concept | ADR | work-item | evidence-needed
Reason: ...
Follow-up: ...
```
Use exactly one disposition. Keep this as a prompt convention, not a validator rule.
7. **Validate.** For each generated page: run `skillwiki validate <page>`. If exit ≠ 0, STOP — do not write index/log.
8. **Apply writes in order.** raw → page(s) → `index.md` → `log.md`.
9. **Confidence flag.** If only one source is cited, set `confidence: low`.
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
- `validate` non-zero on any page.
- sha256 already exists in vault for the same source.
## Forbidden
- Skipping `fetch-guard`.
- Updating `index.md` or `log.md` before all pages validate.
- Modifying any existing file in `raw/`.
- Writing raw ephemeral data directly to cloud-mounted wiki paths (`~/wiki/`).
- Writing `[[wikilinks]]` to pages that don't exist in the vault. Before linking, verify the target exists: check `index.md` or `ls` the target directory. If the target doesn't exist yet, use plain text instead of a wikilink.
## Batch Mode
When the user provides multiple sources (a directory of files, a list of URLs, or a multi-document input):
1. **Loop per source.** Execute steps 1–7 for each source individually (guard → fetch → identity guard → sensitive content guard → hash → generate → validate).
2. **Accumulate, don't write yet.** Collect all raw files and pages in memory. Do not write `index.md` or `log.md` until every source has validated.
3. **Fail fast.** If any page fails validation, STOP. Report all failures. Do not write index/log for any source.
4. **Deduplication.** Before writing each raw file, check `sha256` against existing vault raw sources. Skip sources whose content is already present.
5. **Single index/log update.** After all sources validate, write all raw files and pages, then update `index.md` and `log.md` once.
6. **Progress.** After each source completes validation, report progress (e.g., "Validated 3/10 sources").
