     1|---
     2|version: 0.2.1
     3|name: wiki-ingest
     4|description: Convert URLs, files, or pasted text into typed-knowledge pages with raw provenance. Supports single and batch mode.
     5|---
     6|
     7|# wiki-ingest
     8|
     9|## When This Skill Activates
    10|
    11|- User shares a URL, paste, or local file to capture in the vault.
    12|- The output target is `entities/`, `concepts/`, `comparisons/`, or `queries/`.
    13|- A vault is resolvable (see step 0).
    14|
    15|## Output language
    16|
    17|Run `skillwiki lang` at the start. Generate page-body prose, narrative sections, and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
    18|
    19|## Pre-orientation reads (mandatory before any write)
    20|1. `SCHEMA.md`
    21|2. `index.md`
    22|3. Last 20–30 entries of `log.md`
    23|4. (Project context only) `projects/{slug}/README.md` and last ~5 work-item logs.
    24|
    25|## Steps (in order — N6, N7, N8)
    26|0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`. Use the resolved vault path for all writes; use the canonical language for all generated prose.
    27|1. **Guard.** For each URL: run `skillwiki fetch-guard <url>`. If exit ≠ 0, STOP and surface the error. Do not retry.
    28|2. **Fetch.** Use `web_fetch` (or read local file) under Layer 2 controls (the CLI Layer 2 fetcher applies in tests; in skill runtime use `web_fetch` directly and treat any error as STOP).
    29|3. **Hash.** Write the raw file (frontmatter + body). Run `skillwiki hash <raw-file>` and embed the result in raw frontmatter `sha256:`.
    30|4. **Generate page(s).** Compose typed-knowledge page(s) with citations pre-attached (`^[raw/...]` markers). Every page MUST include:
    31|   - `## TL;DR` as the first section after frontmatter — a 1–3 bullet summary of the page's key takeaway.
    32|   - For pages tagged `architecture` or explaining workflows/systems: include a Mermaid diagram (`graph TB` or `sequenceDiagram`) in the body. Follow Obsidian-compatible Mermaid rules (see SCHEMA.md `## Mermaid Diagrams`).
    33|5. **Validate.** For each generated page: run `skillwiki validate <page>`. If exit ≠ 0, STOP — do not write index/log.
    34|6. **Apply writes in order.** raw → page(s) → `index.md` → `log.md`.
    35|7. **Confidence flag.** If only one source is cited, set `confidence: low`.
    36|
    37|## Provenance defaults
    38|- Default `provenance: research`.
    39|- If cwd is inside `projects/{slug}/`, set `provenance: project` and add `provenance_projects: ["[[slug]]"]`.
    40|
    41|## Raw Data Locality
    42|
    43|Raw ephemeral data (market feeds, logs, transient JSON) must be written to the **project local** `raw/` directory, NOT the cloud-mounted wiki path. See `references/raw-data-locality.md` for the full pattern.
    44|
    45|**Quick rule:**
    46|- Transient data → `~/projects/{slug}/raw/` (local, git-tracked)
    47|- Compound pages → `~/wiki/projects/{slug}/compound/` (cloud, durable)
    48|
    49|## Stop conditions
    50|- `fetch-guard` non-zero.
    51|- Fetch timeout / size limit exceeded.
    52|- `validate` non-zero on any page.
    53|- sha256 already exists in vault for the same source.
    54|
    55|## Forbidden
    56|- Skipping `fetch-guard`.
    57|- Updating `index.md` or `log.md` before all pages validate.
    58|- Modifying any existing file in `raw/`.
    59|- Writing raw ephemeral data directly to cloud-mounted wiki paths (`~/wiki/`).
    60|- Writing `[[wikilinks]]` to pages that don't exist in the vault. Before linking, verify the target exists: check `index.md` or `ls` the target directory. If the target doesn't exist yet, use plain text instead of a wikilink.
    61|
    62|## Batch Mode
    63|
    64|When the user provides multiple sources (a directory of files, a list of URLs, or a multi-document input):
    65|
    66|1. **Loop per source.** Execute steps 1–5 for each source individually (guard → fetch → hash → generate → validate).
    67|2. **Accumulate, don't write yet.** Collect all raw files and pages in memory. Do not write `index.md` or `log.md` until every source has validated.
    68|3. **Fail fast.** If any page fails validation, STOP. Report all failures. Do not write index/log for any source.
    69|4. **Deduplication.** Before writing each raw file, check `sha256` against existing vault raw sources. Skip sources whose content is already present.
    70|5. **Single index/log update.** After all sources validate, write all raw files and pages, then update `index.md` and `log.md` once.
    71|6. **Progress.** After each source completes validation, report progress (e.g., "Validated 3/10 sources").
    72|