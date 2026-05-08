---
version: 0.2.1
name: proj-distill
description: 2-step distillation (E4) — analyze project compound entry, then generate a vault concept page with provenance.
---

# proj-distill

## When to invoke
- A project compound entry captures a pattern that generalizes beyond the project.

## Pre-orientation reads
Standard four + project context.

## Steps (E4 — 2-step pattern)

### Source selection

Check `projects/{slug}/compound/` first. If empty, fall back to retro
entries in vault `log.md` (lines matching `## [YYYY-MM-DD] retro`).

When reading retros as source material:
- Collect all retros for the project, focusing on entries with
  `Generalize?: yes`.
- Group by recurring theme (≥2 occurrences across cycles).
- Each group becomes a candidate concept outline.

1. **Step 1 — Analyze.** Read the source compound entry + linked work
   items (or retro groups from log.md). Output a candidate concept
   outline. STOP if no clear universal pattern is found — surface the
   reasoning instead of forcing a page.
2. **Step 2 — Generate.** Compose the vault concept page with
   `provenance: project` and
   `provenance_projects: ["[[slug]]"]`. Validate with
   `skillwiki validate`.
3. **Backlink.** Set `promoted_to: "[[concept-slug]]"` on the source
   compound entry. For retro-sourced distillation, skip backlink (log.md
   entries are append-only) and instead add `sources:` citing the vault
   log with date range.
4. **Apply writes in order.** Vault concept page → backlink update →
   project `log.md` → vault `index.md` → vault `log.md`.

## Stop conditions
- No clear universal pattern.
- `validate` non-zero on either page.

## Forbidden
- Skipping Step 1 (no direct generation).
- Updating index/logs before `validate` passes.
