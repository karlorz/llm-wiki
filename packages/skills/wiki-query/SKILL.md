---
name: wiki-query
description: Search the vault and synthesize an answer with E2 4-signal ranking. Optional file to queries/ or comparisons/.
---

# wiki-query

## When to invoke
- User asks a question that can be answered from existing vault content.
- Either no scope hint or one of: vault / current-project / project+concepts.

## Pre-orientation reads
Standard four reads (SCHEMA, index, log, project context if applicable).

## Steps
1. **Determine scope.** Ask the user once if ambiguous: vault | current project | project+concepts.
2. **Refresh graph.** If `.skillwiki/graph.json` is missing or older than 24h: `npx skillwiki graph build <vault>`.
3. **Compute overlap.** `npx skillwiki overlap <vault>`.
4. **Score candidates** in prompt using the 4 signals:
   - Direct wikilink: 3.0×
   - Source overlap: 4.0× (read from overlap output)
   - Adamic-Adar: 1.5× (read from graph output)
   - Type affinity: 1.0×
5. **Read top candidates** in full (frontmatter + body).
6. **Synthesize answer** with explicit citations to the candidate pages.
7. **Optional file.** If user accepts: write to `queries/<slug>.md` or `comparisons/<slug>.md` with full frontmatter, validate, then update `index.md` then `log.md`.

## Stop conditions
- Zero matching pages.
- User declines to file.

## Forbidden
- Filing without `validate` passing.
- Skipping the orientation reads even for "quick" queries.
