---
name: proj-distill
description: 2-step distillation (E4) — analyze project compound entry, then generate a vault concept page with provenance.
---

# proj-distill

## When to invoke
- A project compound entry captures a pattern that generalizes beyond the project.

## Pre-orientation reads
Standard four + project context.

## Steps (E4 — 2-step pattern)
1. **Step 1 — Analyze.** Read the source compound entry + linked work items. Output a candidate concept outline. STOP if no clear universal pattern is found — surface the reasoning instead of forcing a page.
2. **Step 2 — Generate.** Compose the vault concept page with `provenance: project` and `provenance_projects: ["[[slug]]"]`. Validate with `npx skillwiki validate`.
3. **Backlink.** Set `promoted_to: "[[concept-slug]]"` on the source compound entry.
4. **Apply writes in order.** Vault concept page → backlink update → project `log.md` → vault `index.md` → vault `log.md`.

## Stop conditions
- No clear universal pattern.
- `validate` non-zero on either page.

## Forbidden
- Skipping Step 1 (no direct generation).
- Updating index/logs before `validate` passes.
