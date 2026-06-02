---
version: 0.2.2
name: proj-work
description: Open or run a work item under projects/{slug}/work/YYYY-MM-DD-{slug}/. Redirects brainstorming/writing-plans output paths.
---

# proj-work

## When to invoke
- User starts a feature, issue, refactor, or decision inside an existing project.
- User asks to "get work of X" or "run work item Y" to review/execute an existing item.
- Brainstorming or writing-plans skills would otherwise default-write outside the project tree.
- If no project context can be determined, default to the `playground` slug so redirect paths always emit and the PRD bridge chain works.

## Pre-orientation reads
Standard four + project context (project README, last ~5 work logs).

## Executing an Existing Work Item

When the user asks to "get work of X" or "run work item Y" for review, you are in EXECUTION mode — not creation mode. Steps:

1. **Resolve the work folder** at `<vault>/projects/{slug}/work/{YYYY-MM-DD-<slug>}/`. If the vault root isn't obvious, run `skillwiki path`.
2. **Read spec.md and tasks.md** in full. The spec defines scope; tasks define the review checklist.
3. **Verify every "DONE" claim against disk.** This is critical — previous sessions routinely mark items DONE in the wiki without actually applying the fix. For each claimed-complete task:
   - Check file existence, content, config values on disk
   - Cross-reference crontab entries, script timeouts, Makefile targets
   - Trust nothing in the wiki alone — validate
4. **Apply missing fixes**, then update the work item with accurate post-fix status.
5. **Set `status: complete`** when all fixes are verified.

## Creating a New Work Item
1. Determine `kind:` (feature | issue | refactor | decision) and slug.
2. Create folder `projects/{slug}/work/YYYY-MM-DD-{work-slug}/`.
3. Override default output paths for any nested skill: `spec.md`, `plan.md`, and `log.md` are written here, not at vault root.
4. Validate work-item frontmatter via `skillwiki validate <spec.md>`. If non-zero, STOP.
5. Manage status transitions: `planned` → `in-progress` → `completed` (set `completed:` date) or `abandoned`.
6. Append vault `log.md` entry on creation and on each status transition.

## Redirect Output

After step 3 (output path override), emit redirect paths for the active PRD skill:

> Work item created: projects/{slug}/work/YYYY-MM-DD-{work-slug}/
>
> Redirect paths for PRD skills:
>   spec -> <vault-root>/projects/{slug}/work/YYYY-MM-DD-{work-slug}/spec.md
>   plan -> <vault-root>/projects/{slug}/work/YYYY-MM-DD-{work-slug}/plan.md
>
> Pass these paths to your PRD skill (superpowers:brainstorming, superpowers:writing-plans,
> CodeStable, or any other). Files land in the vault natively — no separate ingest needed.

Rules:
- Emit redirect paths as the first output after folder creation, before any PRD skill runs.
- Resolve `<vault-root>` via `skillwiki path` (never hardcode).
- proj-work does NOT invoke any PRD skill — it provides paths only.
- If the PRD skill cannot accept custom save paths, fall back to manual `wiki-ingest`.

## Pitfalls
- **Wiki-as-truth fallacy**: tasks.md status markers are aspirational claims by previous sessions. They are often wrong. Always audit the actual file system before accepting a "DONE" label.
- **Re-marking without doing**: do not simply re-write tasks.md to say DONE without applying the corresponding fix. The next session will find the same gap.

## Stop conditions
- `validate` non-zero.
- Conflicting work folder name.

## Forbidden
- Writing spec/plan files outside the work folder.
- Marking `status: completed` without a `completed:` date.
- Accepting tasks.md status labels without independent disk verification.
