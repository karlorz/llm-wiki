     1|     1|---
     2|     2|version: 0.2.2
     3|     3|name: wiki-query
     4|     4|description: Search the vault and synthesize an answer with E2 4-signal ranking. Optional file to queries/ or comparisons/.
     5|     5|---
     6|     6|
     7|     7|# wiki-query
     8|     8|
     9|     9|## When This Skill Activates
    10|    10|
    11|    11|- User asks a question that should be answered from vault contents.
    12|    12|- A vault is resolvable (see step 0).
    13|    13|
    14|    14|## Output language
    15|    15|
    16|    16|Run `skillwiki lang` at the start. Generate query-result prose and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
    17|    17|
    18|    18|## Pre-orientation reads
    19|    19|Standard four reads (SCHEMA, index, log, project context if applicable).
    20|    20|
    21|    21|## Steps
    22|    22|0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
    23|    23|1. **Determine scope.** Ask the user once if ambiguous: vault | current project | project+concepts.
    24|    24|2. **Refresh graph.** If `.skillwiki/graph.json` is missing or older than 24h: `skillwiki graph build <vault>`.
    25|    25|3. **Compute overlap.** `skillwiki overlap <vault>`.
    26|    26|4. **Score candidates** in prompt using the 4 signals:
    27|    27|   - Direct wikilink: 3.0×
    28|    28|   - Source overlap: 4.0× (read from overlap output)
    29|    29|   - Adamic-Adar: 1.5× (read from graph output)
    30|    30|   - Type affinity: 1.0×
    31|    31|5. **Read top candidates** in full (frontmatter + body).
    32|    32|6. **Synthesize answer** with explicit citations to the candidate pages.
    33|    33|7. **Optional file.** If user accepts: write to `queries/<slug>.md` or `comparisons/<slug>.md` with full frontmatter, validate, then update `index.md` then `log.md`.
    34|    34|
    35|    35|## Stop conditions
    36|    36|- Zero matching pages.
    37|    37|- User declines to file.
    38|    38|
    39|    39|## Pitfalls
    40|    40|
    41|    41|### Claimed-status vs actual-state gap
    42|    42|When a wiki page (especially a work item `tasks.md`) claims that fixes were applied, features were completed, or files were removed — **verify on disk before accepting the claim**. In one incident, a `tasks.md` marked 6 items DONE but 5 were not actually applied: a script claimed "removed" was still 2020 bytes on disk, a crontab claimed "updated to 30min" was still `*/10`, and a build target claimed "verified has consumers" had no web server serving it. 
    43|    43|
    44|    44|**Rule**: After reading a work item that declares completion, run at least one verification command per critical claim (check file existence, grep a config, inspect a crontab). Documents can drift from reality — the filesystem is the source of truth.
    45|    45|
    46|    46|## Forbidden
    47|    47|- Filing without `validate` passing.
    48|    48|- Skipping the orientation reads even for "quick" queries.
    49|    49|
