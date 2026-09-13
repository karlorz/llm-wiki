---
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

## Leaf hosts (HTTP MCP)
On a leaf host (vault has `.WIKI_GIT_FROZEN` or the HTTP MCP server is the writer), bootstrap goes through MCP instead of local file creation:
- Write `projects/{slug}/README.md` and any initial `requirements/` or `architecture/` markdown via `wiki_workitem_write` (CAS: omit `base_sha256` on create). Directories materialize implicitly with the first file.
- The `index.md` "Projects" line and the structural log stay projection/snapshotter-owned: use at most `wiki_log_append` for the init entry. Never edit `index.md` locally on a leaf.
- If `wiki_workitem_write` is absent from the live tool list or the deployed server predates the workspace-family allowlist (`PATH_DENIED`), STOP — do not local-write, rclone, or wiki-push.

## Stop conditions
- `projects/{slug}/` already exists.
- Leaf host without a usable `wiki_workitem_write` (fail closed; capture the intent via `wiki_capture` instead).

## Forbidden
- Modifying any other project's files.
