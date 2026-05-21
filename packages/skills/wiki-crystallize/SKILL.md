---
version: 0.2.1
name: wiki-crystallize
description: Distill the current working session into a typed-knowledge page with provenance.
---
# wiki-crystallize
## When This Skill Activates
- User asks to crystallize, consolidate, or promote draft material into typed-knowledge pages.
- A vault is resolvable (see step 0).
## Output language
Run `skillwiki lang` at the start. Generate consolidated page prose and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
## Pre-orientation reads
Standard four reads. If cwd is inside `projects/{slug}/`, also read project README and recent work logs.
## Steps
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
1. Identify type: entity / concept / comparison / query / summary.
2. Set `provenance:`. Default `research`. If in project context: `project` with `provenance_projects: ["[[slug]]"]`.
3. Compose the page with citations pre-attached. Reuse existing `raw/` sources where possible. Every page MUST include:
- `> **TL;DR:**` blockquote as the first content after the title heading — a one-sentence summary of the page's key takeaway (under 200 chars). See SCHEMA.md `## TL;DR Convention`.
- For pages tagged `architecture` or explaining workflows/systems: include a Mermaid diagram (`graph TB` or `sequenceDiagram`) in the body. Follow Obsidian-compatible Mermaid rules (see SCHEMA.md `## Mermaid Diagrams`).
4. `skillwiki validate <page>`. If non-zero, STOP.
5. Apply writes: page → `index.md` → `log.md`.
## Stop conditions
- `validate` non-zero.
- Missing `provenance:` for project-context runs.
## Forbidden
- Filing without explicit `provenance:`.
- Updating `index.md` before `validate` passes.
- Writing `[[wikilinks]]` to pages that don't exist in the vault. Before linking, verify the target exists: check `index.md` or `ls` the target directory. If the target doesn't exist yet, use plain text instead of a wikilink.
