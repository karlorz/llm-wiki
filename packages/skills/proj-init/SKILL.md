---
version: 0.2.1
name: proj-init
description: Bootstrap a project workspace at projects/{slug}/ with README, requirements/, architecture/, work/, compound/.
---

# proj-init

## When to invoke
- User starts a new project that should live inside the vault.

## Pre-orientation reads
Standard four reads (vault SCHEMA, index, log) — no project context yet.

## Inputs
- Slug (lowercase, hyphenated).
- One-line intent.

## Steps
1. Verify `projects/{slug}/` does not exist.
2. Create folders: `projects/{slug}/{requirements,architecture,work,compound}/`.
3. Render `projects/{slug}/README.md` from `project-README.md` template, filling `{{slug}}` and `{{date}}`. The template includes a `## Knowledge Pages` section with a placeholder; agents populate it on first ingest via `skillwiki project-index`.
4. Update vault `index.md` "Projects" section: add `- [[projects/{slug}]]`.
5. Append vault `log.md` entry: "Project {slug} initialized."

## Stop conditions
- `projects/{slug}/` already exists.

## Forbidden
- Modifying any other project's files.
