---
name: wiki-adapter-prd
description: Map foreign PRD formats (CodeStable, RFCs, structured markdown) into skillwiki raw + typed-knowledge pages.
---

# wiki-adapter-prd

## When This Skill Activates

- User provides a document or URL in a non-skillwiki PRD format and wants it captured in the vault.
- User mentions CodeStable, RFC, AIDE, or another structured design document format.
- A foreign spec/plan needs to be normalized into the vault's raw + concept structure.

## Output language

Run `skillwiki lang` at the start. Generate page prose in the resolved language. Frontmatter keys, file names, and structural markers stay English.

## Pre-orientation reads

Standard four reads (SCHEMA, index, log, project context if applicable).

## Recognized PRD Formats

| Format | Structural cues |
|--------|----------------|
| CodeStable | `REQ-NNN` requirement IDs, `## Requirements` / `## Architecture` headers |
| RFC | `## Motivation` / `## Proposal` / `## Drawbacks` headers |
| AIDE directives | Specific YAML frontmatter keys (`aide-*`) |
| Hermes spec | `N1`–`N18` normative requirement markers |
| Generic structured | Clear `##` section hierarchy with requirements, decisions, or designs |

If the format is unrecognized, treat as generic structured markdown and map by section hierarchy.

## Mapping Strategy

### Raw capture (verbatim)

- Write the full source document to `raw/articles/<slug>.md` with RawSourceSchema frontmatter (`sha256`, `source_url`, `ingested`, `ingested_by: "wiki-ingest"`).
- If the source is a URL, run `skillwiki fetch-guard <url>` first.
- Run `skillwiki hash <raw-file>` to compute sha256.

### Knowledge extraction

Map source sections to typed-knowledge pages:

| Source section | Target type | Notes |
|----------------|-------------|-------|
| Requirements list | `concepts/` or `entities/` | Each major requirement becomes its own page or a section in a compound page |
| Architecture decisions | `concepts/` | Map to concept pages with `tags: [architecture]` |
| Motivation / context | `entities/` | Capture as entity pages describing the system or component |
| Trade-offs / comparisons | `comparisons/` | Create comparison pages when the source weighs alternatives; include a `Decision Closeout` block |
| Action items / next steps | Skip | Not knowledge — track in project work items instead |

### Cross-reference handling

- Requirement IDs (`REQ-NNN`, `N1`–`N18`) → preserve as frontmatter tags or inline references.
- Internal links within the source → convert to `[[wikilinks]]` where corresponding pages exist.
- External URLs → keep as-is in body text.

## Steps

0. Resolve vault and language: `skillwiki path` and `skillwiki lang`.
1. Classify the input format using the structural cues above.
2. If URL source: run `skillwiki fetch-guard <url>`, then fetch.
3. **Sensitive content guard.** Before writing the raw capture or generated pages, scan the source and generated body for live credentials, access keys, tokens, passwords, cookies, bearer headers, or private keys. Redact generated prose before writing. If the source itself contains a live secret and would need to remain raw, STOP instead of preserving it.
4. Write raw capture: frontmatter + full body → `raw/articles/<slug>.md`.
5. Run `skillwiki hash <raw-file>`, embed sha256.
6. Generate typed-knowledge pages following the mapping strategy.
   For generated comparison or evaluation pages, end the body with:
   ```markdown
   ## Decision Closeout

   Disposition: no-op | concept | ADR | work-item | evidence-needed
   Reason: ...
   Follow-up: ...
   ```
   Use exactly one disposition. Preserve action items as skipped project-management content unless the closeout explicitly says `work-item`.
7. For each page: run `skillwiki validate <page>`. If any fails, STOP.
8. Write pages, then update `index.md` and `log.md`.

## Provenance defaults

- `provenance: research` (external PRD sources).
- `sources: ["^[raw/articles/<slug>.md]"]` on every generated page.

## Stop conditions

- `fetch-guard` non-zero.
- `validate` non-zero on any page.
- sha256 already exists for the same source (skip — already ingested).
- Source or generated content contains unredacted live credentials or other authenticating secrets.

## Forbidden

- Skipping `fetch-guard` for URL sources.
- Writing index/log before all pages validate.
- Modifying existing raw files (N9).
- Auto-generating pages for action items, timelines, or process steps — those are project management, not knowledge.
- Writing live credentials, access keys, tokens, passwords, cookies, bearer headers, private keys, or other authenticating secrets to the vault.
