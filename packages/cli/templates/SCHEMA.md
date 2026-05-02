# Vault Schema

This vault follows the CodeWiki schema (Hermes llm-wiki v2.1.0 wire-compatible).

## Layers

- `raw/` — immutable source material (never modify after ingest).
- `entities/`, `concepts/`, `comparisons/`, `queries/` — typed knowledge unified across origin via `provenance:`.
- `meta/` — cross-project synthesis (notes naming ≥2 projects).
- `projects/{slug}/` — per-project lifecycle workspace.

## Frontmatter

Four shapes: typed-knowledge, raw, work-item, compound. See spec for full Zod schemas.

## Conventions

- File names: lowercase-hyphenated, no spaces.
- Wikilinks in YAML: quoted, `"[[name]]"`. Body wikilinks: unquoted `[[name]]`.
- Citations in body: `^[raw/...]` markers; every entry in `sources:` MUST appear in body.
- sha256 in `raw/` frontmatter is computed by `skillwiki hash` over body bytes after closing `---`.
