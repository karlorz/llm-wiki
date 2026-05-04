---
name: proj-work
description: Open or run a work item under projects/{slug}/work/YYYY-MM-DD-{slug}/. Redirects brainstorming/writing-plans output paths.
---

# proj-work

## When to invoke
- User starts a feature, issue, refactor, or decision inside an existing project.
- Brainstorming or writing-plans skills would otherwise default-write outside the project tree.

## Pre-orientation reads
Standard four + project context (project README, last ~5 work logs).

## Steps
1. Determine `kind:` (feature | issue | refactor | decision) and slug.
2. Create folder `projects/{slug}/work/YYYY-MM-DD-{work-slug}/`.
3. Override default output paths for any nested skill: `spec.md`, `plan.md`, and `log.md` are written here, not at vault root.
4. Validate work-item frontmatter via `npx skillwiki validate <spec.md>`. If non-zero, STOP.
5. Manage status transitions: `planned` → `in-progress` → `completed` (set `completed:` date) or `abandoned`.
6. Append vault `log.md` entry on creation and on each status transition.

## Redirect Output

After step 3 (output path override), emit redirect paths for the active PRD skill:

> Work item created: projects/{slug}/work/YYYY-MM-DD-{work-slug}/
>
> Redirect paths for PRD skills:
>   spec → <vault-root>/projects/{slug}/work/YYYY-MM-DD-{work-slug}/spec.md
>   plan → <vault-root>/projects/{slug}/work/YYYY-MM-DD-{work-slug}/plan.md
>
> Pass these paths to your PRD skill (superpowers:brainstorming, superpowers:writing-plans,
> CodeStable, or any other). Files land in the vault natively — no separate ingest needed.

Rules:
- Emit redirect paths as the first output after folder creation, before any PRD skill runs.
- Resolve `<vault-root>` via `skillwiki path` (never hardcode).
- proj-work does NOT invoke any PRD skill — it provides paths only.
- If the PRD skill cannot accept custom save paths, fall back to manual `wiki-ingest`.

## Stop conditions
- `validate` non-zero.
- Conflicting work folder name.

## Forbidden
- Writing spec/plan files outside the work folder.
- Marking `status: completed` without a `completed:` date.
