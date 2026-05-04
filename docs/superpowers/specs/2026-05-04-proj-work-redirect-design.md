# proj-work Redirect — Design Specification

**Date**: 2026-05-04
**Status**: Approved for plan generation
**Canonical**: this document.
**Repo**: `/Users/karlchow/Desktop/code/llm-wiki`

## TL;DR

Make `proj-work` emit vault-native redirect paths for spec and plan files, so any PRD skill (superpowers, CodeStable, or future alternatives) writes directly into the vault. No separate ingest step needed. No coupling to any specific PRD skill. Update the dev-loop-prompt to reference the new loop.

## Motivation

Currently, superpowers writes specs/plans to `docs/superpowers/{specs,plans}/` and the user must manually invoke `wiki-ingest` to capture them in the vault. This creates:

- **Dual copies** — repo files and vault raw sources for the same content
- **Manual step** — the ingest is easily forgotten, causing knowledge gaps
- **PRD coupling** — the workflow assumes superpowers as the only PRD skill

The `proj-work` skill was already designed to override PRD output paths (see spec `2026-05-02-llm-wiki-skill-design.md`, proj-work row). This design activates that existing capability.

## Design Decisions

1. **proj-work emits redirect paths** — after creating a work item folder, proj-work outputs explicit spec and plan paths inside the vault. No new skill, no CLI change.
2. **PRD-agnostic** — proj-work does not reference superpowers or any specific PRD skill. It provides paths; any PRD skill that supports custom save locations uses them.
3. **No ingest step** — files land in the vault natively via `projects/{slug}/work/YYYY-MM-DD-{slug}/`. The vault's `index.md` and `log.md` are updated by proj-work (existing behavior).
4. **Fallback preserved** — if a user runs a PRD skill without proj-work, files go to the PRD skill's default location and can still be manually ingested via `wiki-ingest`.
5. **No CLAUDE.md coupling** — the redirect is emitted by proj-work at runtime, not hardcoded into project configuration. This keeps the pattern portable across projects and PRD skills.
6. **Dev-loop-prompt updated** — the reusable loop prompt in memory is updated to reflect the new flow, removing ingest steps and making PRD skill pluggable.

## Changes

### 1. `packages/skills/proj-work/SKILL.md`

Add a "Redirect Output" section after the work item creation step:

```markdown
## Redirect Output

After creating the work item folder, emit redirect paths for the PRD skill:

> Work item created: projects/{slug}/work/YYYY-MM-DD-{work-slug}/
>
> Redirect paths for PRD skills:
>   spec → <vault-root>/projects/{slug}/work/YYYY-MM-DD-{work-slug}/spec.md
>   plan → <vault-root>/projects/{slug}/work/YYYY-MM-DD-{work-slug}/plan.md
>
> When your PRD skill (superpowers:brainstorming, superpowers:writing-plans,
> CodeStable, or any other) asks where to save output, pass these paths.
> Files land in the vault natively — no separate ingest step needed.

Rules:
- Always emit redirect paths as the first output after folder creation.
- Paths use the resolved vault root from `skillwiki path` (not hardcoded).
- proj-work does NOT invoke any PRD skill — it provides the paths only.
- If the PRD skill does not support custom save paths, fall back to manual
  ingest via `wiki-ingest`.
```

### 2. Dev-loop-prompt (memory file)

Update the loop from 11 steps to 9:

```
1. QUERY     wiki-query → vault context check
2. WORK      proj-work → create work item, emit redirect paths
3. SPEC      <any PRD skill> → writes spec to vault redirect path
4. PLAN      <any PRD skill> → writes plan to vault redirect path
5. EXECUTE   <any PRD execution skill> → implement
6. SAVE      wiki-crystallize → session insights
7. SIMPLIFY  /simplify review → fix issues
8. E2E       e2e-local → e2e-remote → plugin
9. PUSH      git push dev + npm publish beta
```

**Removed:** INGEST steps (3 and 5 from old loop). Files are already in vault.

**Added:** WORK step as the new entry point before PRD skills.

**Updated rules:**
- Replace "Never skip ingest" with "Always use proj-work redirect paths"
- Add "PRD skill is pluggable — superpowers is default, not required"
- Add fallback: "If proj-work redirect fails, use wiki-ingest manually"

## Backward Compatibility

- **Existing `docs/superpowers/` files**: remain as historical reference. No migration, no deletion.
- **Superpowers default behavior**: unchanged. If a user runs `superpowers:brainstorming` without proj-work, it writes to `docs/superpowers/specs/` as before.
- **Non-superpowers PRD skills**: work with proj-work if they accept custom save paths. Otherwise, manual ingest via `wiki-ingest` is the fallback.
- **No code changes**: only SKILL.md prompt text and memory file are modified. No CLI changes, no new dependencies.

## Scope

### In this change
- Update `packages/skills/proj-work/SKILL.md` with redirect output section
- Update memory `dev-loop-prompt.md` with new loop and updated rules

### Not in this change
- CLI changes (no new subcommands)
- New skills or hooks
- Changes to superpowers or any other PRD skill
- Deletion or migration of `docs/superpowers/` files
- proj-distill changes (distillation of work items into concepts works as-is)

## Testing

- Manual verification: run proj-work, confirm redirect paths are emitted
- Manual verification: run superpowers:brainstorming with redirect paths, confirm spec lands in vault
- Manual verification: run superpowers:writing-plans with redirect paths, confirm plan lands in vault
- Verify `skillwiki validate` passes on work item frontmatter
- Verify vault `log.md` is updated by proj-work on creation and status transitions
- Note: `index.md` is only updated by `proj-init` (project registration), not by individual work items
