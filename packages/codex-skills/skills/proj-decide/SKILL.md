---
name: proj-decide
description: Write an Architectural Decision Record (ADR). If the decision generalizes, also create a concepts/ page.
---

# proj-decide

## When to invoke
- User commits to an architectural decision worth recording for future reference.

## Pre-orientation reads
Standard four + project context.

## Steps
1. Compose the ADR in `projects/{slug}/architecture/YYYY-MM-DD-{adr-slug}.md`. Frontmatter: kind=decision, status=in-progress or completed, project link. If no project context exists, default to `playground`.
2. `skillwiki validate <adr>`. If non-zero, STOP.
3. **Generalization check.** If the decision applies beyond this project, create a `concepts/` page with `provenance: project` (or `mixed` if research-informed).
4. Apply writes: ADR → (optional) concept page → vault `index.md` → vault `log.md` and project `log.md`.

## Stop conditions
- `validate` non-zero on either page.

## Forbidden
- Filing the concept page without explicit `provenance:`.
