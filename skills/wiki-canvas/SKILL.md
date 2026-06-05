---
name: wiki-canvas
description: Generate an Obsidian Canvas visualization of the vault graph. Runs skillwiki graph build then skillwiki canvas generate.
---

# wiki-canvas

## When This Skill Activates

- User wants a visual map of their vault structure.
- User asks to see how pages are connected.
- After significant ingestion or restructuring, user wants an updated overview.
- User mentions Obsidian Canvas or visual vault exploration.

## Pre-orientation reads

Standard four reads (SCHEMA, index, log, project context if applicable).

## Steps

0. Resolve vault: `skillwiki path`.
1. Run `skillwiki graph build <vault>` to produce the adjacency graph at `<vault>/.skillwiki/graph.json`. If graph.json already exists and the vault has not changed, this step can be skipped — but regenerate after any ingestion, reingest, archive, or restructuring to keep the canvas current.
2. Run `skillwiki canvas generate <vault>`. This reads graph.json and writes `<vault>/vault-graph.canvas`.
3. Present the result to the user: node count, edge count, and the output path.
4. Advise the user on opening the canvas:
   - In Obsidian, open the vault folder and click `vault-graph.canvas` in the file explorer, or use the Quick Switcher (`Cmd/Ctrl+O`) and search for "vault-graph".
   - Nodes are arranged in columns by type: **entities** (red), **concepts** (green), **comparisons** (orange), **queries** (cyan), **meta** (purple). Unclassified pages appear in yellow in the comparisons column.
   - Edges represent wikilink connections. Click any node to jump to the source page; drag to rearrange.
   - Zoom and pan with mouse/trackpad to explore large vaults.
5. Append one `log.md` entry noting the canvas generation (node/edge counts).

## When to regenerate

Regenerate the canvas after any of these events:
- One or more `wiki-ingest` runs that added new pages.
- `wiki-reingest` or `wiki-archive` that changed or removed pages.
- Manual restructuring of the vault directories.
- After running `wiki-lint` and fixing structural issues.

Stale canvases are not harmful, but they will not reflect new or removed pages until regenerated.

## Future: Bases view

Obsidian Bases (`.base` files) offer tabular data views of vault content. A Bases generation capability may be added in a future version to complement the graph canvas with filterable, sortable table layouts. For now, the canvas is the primary visualization.

## Stop conditions

- `skillwiki graph build` returns a non-zero exit code — investigate before continuing.
- `graph.json` is missing or invalid — the canvas command will surface the error; direct the user to run `skillwiki graph build` first.
- User cancels before generation.

## Forbidden

- Modifying `vault-graph.canvas` by hand after generation — regenerate it instead.
- Regenating the canvas without first regenerating graph.json when the vault has changed.
- Deleting the previous canvas without generating a replacement.
