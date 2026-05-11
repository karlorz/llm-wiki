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

```yaml
taxonomy:
{{TAXONOMY_YAML}}
```

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
- Citations in body: `^[raw/...]` markers at paragraph-end; every entry in `sources:` MUST appear in body and in `## Sources` footer.
- Legacy inline `^[raw/...]` markers remain valid; `migrate-citations` converts them.
- sha256 in `raw/` frontmatter is computed by `skillwiki hash` over body bytes after closing `---`.
- Every typed-knowledge page SHOULD include a `## TL;DR` section near the top (after frontmatter, before `## Overview`). Lint flags pages missing it as `missing_tldr` (info).

## Mermaid Diagrams

Pages explaining architectures, workflows, or complex concepts SHOULD include inline Mermaid diagrams. Lint flags architecture-tagged pages without a ` ```mermaid ` block as `missing_diagram` (info).

Obsidian-compatible Mermaid rules:
- Prefer `graph TB` / `sequenceDiagram`.
- Use `subgraph "Title"` (avoid `subgraph ID[Label]`).
- Avoid `\n` in labels; use `<br/>` or single-line labels.
- Keep node IDs ASCII and simple (`CMUX_DB`, `OC_GW`).

## Obsidian Integration

- **Attachment folder:** `raw/assets/` — binary assets (images, diagrams) live here.
  Set Obsidian's "Attachment folder path" to `raw/assets` for automatic filing.
- **Dataview queries** (read-only; do not replace index.md):

```dataview
LIST WHERE type = "concept" AND contains(tags, "architecture")
```

```dataview
TABLE updated, length(sources) AS sources
WHERE file.folder = "concepts"
SORT updated DESC
```
