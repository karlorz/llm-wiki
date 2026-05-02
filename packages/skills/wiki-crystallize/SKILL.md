---
name: wiki-crystallize
description: Distill the current working session into a typed-knowledge page with provenance.
---

# wiki-crystallize

## When to invoke
- User asks to capture a session as a vault page.
- A reasoning thread has produced a stable insight worth durable storage.

## Pre-orientation reads
Standard four reads. If cwd is inside `projects/{slug}/`, also read project README and recent work logs.

## Steps
1. Identify type: entity / concept / comparison / query / summary.
2. Set `provenance:`. Default `research`. If in project context: `project` with `provenance_projects: ["[[slug]]"]`.
3. Compose the page with citations pre-attached. Reuse existing `raw/` sources where possible.
4. `npx skillwiki validate <page>`. If non-zero, STOP.
5. Apply writes: page → `index.md` → `log.md`.

## Stop conditions
- `validate` non-zero.
- Missing `provenance:` for project-context runs.

## Forbidden
- Filing without explicit `provenance:`.
- Updating `index.md` before `validate` passes.
