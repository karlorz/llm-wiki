# Vault Schema

## Domain

Knowledge base for agentic coding tools, documentation, and project architecture.

## Output Language

en

This sets the language of generated page prose. Frontmatter keys, schema section headers, file names, and log/index structural lines remain English.

## Layers

- `raw/` — immutable evidence. Never rewrite existing content/frontmatter or autonomously remove an object.
- `entities/`, `concepts/`, `comparisons/`, `queries/` — typed knowledge unified across origin via `provenance:`.
- `meta/` — cross-project synthesis.
- `projects/{slug}/` — per-project lifecycle workspace.

## Frontmatter

All typed pages require YAML frontmatter specifying `title`, `description`, `tags`, `created`, `updated`, and `provenance`.

## Tag Taxonomy

```yaml
taxonomy:
  - architecture
  - mcp
  - launch
  - integration
  - agents
```

Rule: every tag on every page MUST appear in this taxonomy. Add new tags here first, then use them.

## Conventions

- File names: lowercase-hyphenated, no spaces.
- Wikilinks in YAML: quoted, `"[[name]]"`. Body wikilinks: unquoted `[[name]]`.
- Every typed-knowledge page SHOULD include a `## TL;DR` section near the top.
