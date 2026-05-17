     1|---
     2|version: 0.2.1
     3|name: wiki-crystallize
     4|description: Distill the current working session into a typed-knowledge page with provenance.
     5|---
     6|
     7|# wiki-crystallize
     8|
     9|## When This Skill Activates
    10|
    11|- User asks to crystallize, consolidate, or promote draft material into typed-knowledge pages.
    12|- A vault is resolvable (see step 0).
    13|
    14|## Output language
    15|
    16|Run `skillwiki lang` at the start. Generate consolidated page prose and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
    17|
    18|## Pre-orientation reads
    19|Standard four reads. If cwd is inside `projects/{slug}/`, also read project README and recent work logs.
    20|
    21|## Steps
    22|0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
    23|1. Identify type: entity / concept / comparison / query / summary.
    24|2. Set `provenance:`. Default `research`. If in project context: `project` with `provenance_projects: ["[[slug]]"]`.
    25|3. Compose the page with citations pre-attached. Reuse existing `raw/` sources where possible. Every page MUST include:
    26|   - `## TL;DR` as the first section after frontmatter — a 1–3 bullet summary of the page's key takeaway.
    27|   - For pages tagged `architecture` or explaining workflows/systems: include a Mermaid diagram (`graph TB` or `sequenceDiagram`) in the body. Follow Obsidian-compatible Mermaid rules (see SCHEMA.md `## Mermaid Diagrams`).
    28|4. `skillwiki validate <page>`. If non-zero, STOP.
    29|5. Apply writes: page → `index.md` → `log.md`.
    30|
    31|## Stop conditions
    32|- `validate` non-zero.
    33|- Missing `provenance:` for project-context runs.
    34|
    35|## Forbidden
    36|- Filing without explicit `provenance:`.
    37|- Updating `index.md` before `validate` passes.
    38|- Writing `[[wikilinks]]` to pages that don't exist in the vault. Before linking, verify the target exists: check `index.md` or `ls` the target directory. If the target doesn't exist yet, use plain text instead of a wikilink.
    39|