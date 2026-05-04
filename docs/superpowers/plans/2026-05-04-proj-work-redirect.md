# proj-work Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proj-work emit vault-native redirect paths so any PRD skill writes specs/plans directly into the vault, eliminating the manual ingest step.

**Architecture:** Two-file prompt-only change — add a "Redirect Output" section to proj-work's SKILL.md and update the dev-loop-prompt memory file to remove ingest steps and make the PRD skill pluggable.

**Tech Stack:** Markdown (SKILL.md prompts, memory file)

**Spec:** `docs/superpowers/specs/2026-05-04-proj-work-redirect-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/skills/proj-work/SKILL.md` | Modify | Add "Redirect Output" section between step 3 and step 4 |
| `~/.claude/projects/-Users-karlchow-Desktop-code-llm-wiki/memory/dev-loop-prompt.md` | Modify | Replace 11-step loop with 9-step loop, update rules and step details |

---

### Task 1: Add Redirect Output section to proj-work SKILL.md

**Files:**
- Modify: `packages/skills/proj-work/SKILL.md:16-22` (after step 3, before step 4)

- [ ] **Step 1: Add the Redirect Output section**

Insert a new section between the existing Steps block and the Stop conditions block. The section goes after step 3 ("Override default output paths...") and before step 4 ("Validate work-item frontmatter...").

Replace the current `## Steps` section (lines 15–22) with:

```markdown
## Steps
1. Determine `kind:` (feature | issue | refactor | decision) and slug.
2. Create folder `projects/{slug}/work/YYYY-MM-DD-{work-slug}/`.
3. Override default output paths for any nested skill: `spec.md`, `plan.md`, and `log.md` are written here, not at vault root.
4. Validate work-item frontmatter via `npx skillwiki validate <spec.md>`. If non-zero, STOP.
5. Manage status transitions: `planned` → `in-progress` → `completed` (set `completed:` date) or `abandoned`.
6. Append vault `log.md` entry on creation and on each status transition.

## Redirect Output

After step 3 (folder creation), emit redirect paths for the active PRD skill:

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
```

- [ ] **Step 2: Verify the file is valid Markdown**

Run: `cat packages/skills/proj-work/SKILL.md | head -5`
Expected: frontmatter intact (`---`, `name: proj-work`, etc.)

- [ ] **Step 3: Commit**

```bash
git add packages/skills/proj-work/SKILL.md
git commit -m "feat: add redirect output section to proj-work SKILL.md

proj-work now emits vault-native redirect paths for spec.md and plan.md
after work item creation. PRD-agnostic — any skill that accepts custom
save paths can write directly into the vault."
```

---

### Task 2: Update dev-loop-prompt memory file

**Files:**
- Modify: `~/.claude/projects/-Users-karlchow-Desktop-code-llm-wiki/memory/dev-loop-prompt.md`

- [ ] **Step 1: Replace the System Context table**

Replace the current System Context table (lines 13–20) with a PRD-agnostic version:

```markdown
## System Context

| Layer | Tool | Role |
|-------|------|------|
| PRD | Any compatible skill (superpowers, CodeStable, etc.) | Brainstorming, spec writing, plan writing, execution, review |
| Knowledge | `skillwiki` (CLI + skills) | Ingest, validate, query, crystallize, lint |
| Quality | `/simplify` | Code review gate before any push |
| Compat | Hermes v2.1.0 | Wire-compatible `~/.hermes/.env` fallback for vault path |

CLI entry point (when installed binary returns placeholder): `npx tsx packages/cli/src/cli.ts <command>`
```

- [ ] **Step 2: Replace the loop diagram**

Replace the current 11-step loop (lines 24–39) with the 9-step loop:

```markdown
## The Loop

For each feature or task in the session, run this cycle:

```
┌──────────────────────────────────────────────────────┐
│  1. QUERY     wiki-query → vault context check       │
│  2. WORK      proj-work → create work item + paths   │
│  3. SPEC      <PRD skill> → spec to vault path       │
│  4. PLAN      <PRD skill> → plan to vault path       │
│  5. EXECUTE   <PRD execution skill> → implement      │
│  6. SAVE      wiki-crystallize → session insights    │
│  7. SIMPLIFY  /simplify review → fix issues          │
│  8. E2E       e2e-local → e2e-remote → plugin        │
│  9. PUSH      git push dev + npm publish beta        │
└──────────────────────────────────────────────────────┘
```
```

- [ ] **Step 3: Replace step details**

Replace the current step details (lines 43–93) with:

```markdown
### Step Details

**1. QUERY** — `skillwiki:wiki-query`
Run before starting any new work. Check the vault for existing specs, plans, concepts, or decisions that overlap with the task. Feed results into the PRD skill's exploration step.

**2. WORK** — `skillwiki:proj-work`
Create a work item under `projects/{slug}/work/YYYY-MM-DD-{work-slug}/`. proj-work emits redirect paths for spec.md and plan.md. These paths are passed to the PRD skill in steps 3 and 4.

**3. SPEC** — `<any PRD skill>`
Invoke the active PRD skill's brainstorming/design phase. Pass the redirect path from step 2 so the spec lands in the vault at `projects/{slug}/work/YYYY-MM-DD-{work-slug}/spec.md`. Default PRD skill: `superpowers:brainstorming`.

**4. PLAN** — `<any PRD skill>`
Invoke the active PRD skill's planning phase. Pass the redirect path from step 2 so the plan lands in the vault at `projects/{slug}/work/YYYY-MM-DD-{work-slug}/plan.md`. Default PRD skill: `superpowers:writing-plans`.

**5. EXECUTE** — `<any PRD execution skill>`
Preferred: `superpowers:subagent-driven-development`. Falls back to `superpowers:executing-plans` if subagents aren't suitable.

**6. SAVE** — `skillwiki:wiki-crystallize`
At natural breakpoints (feature complete, session ending, architectural decision made), crystallize session insights that aren't in any spec or plan.

**7. SIMPLIFY** — `/simplify` review
Run on all modified/new files. Fix every issue it raises. This is a hard gate — no bypassing.

**8. E2E** — `scripts/e2e-local.sh` → `scripts/e2e-remote.sh` → `scripts/e2e-plugin.sh`
Run in order. Each must pass fully before the next starts:
- `e2e-local.sh`: 73 assertions, builds from source, no network
- `e2e-remote.sh`: 48 assertions on sg01 via SSH, installs from npm beta
- `e2e-plugin.sh`: 27 assertions on sg01, verifies plugin channel

**9. PUSH**
- `git push origin dev` — this IS the plugin release (no version pinning for plugins)
- `npm publish --tag beta` — CLI beta channel (separate from plugin)
- Bump `version` in `plugin.json` before push — `/plugin update` won't detect changes without it

**10. RETRO** — Self-learning (after PUSH)
After each cycle completes, note what worked and what didn't:
- Did a step feel unnecessary? Mark it for review.
- Did the vault query miss relevant prior work? Improve the query terms.
- Did simplify catch something that earlier steps should have caught? Feed it back.
- Update this prompt in memory if the loop needs adjusting.
```

- [ ] **Step 4: Update Hard Rules**

Replace the current Hard Rules section (lines 130–139) with:

```markdown
## Hard Rules

1. **Always start with proj-work.** Use `skillwiki:proj-work` to create work items and emit redirect paths before any PRD skill runs.
2. **PRD skill is pluggable.** superpowers is the default, not required. Any PRD skill that accepts custom save paths works.
3. **Never push without simplify + E2E.** Both gates must pass.
4. **Validate before index.** `skillwiki validate` must pass before touching `index.md` or `log.md`.
5. **Raw is immutable.** Never modify files in `raw/` after ingestion.
6. **Trust the vault for history.** Query the wiki, not git history, for past decisions.
7. **Provenance stays project.** All pages: `provenance: project`, `provenance_projects: ["[[llm-wiki]]"]`.
8. **Exit codes are stable.** New failure classes get unused codes; never reassign existing codes.
9. **Fallback to wiki-ingest.** If proj-work redirect fails or the PRD skill can't accept custom paths, use `wiki-ingest` manually.
```

- [ ] **Step 5: Update Cut-over Criteria**

Replace the current Cut-over Criteria section (lines 119–128) with:

```markdown
## Cut-over Status

**Active.** Specs and plans now land in the vault via proj-work redirect paths. The `docs/superpowers/` directory remains as historical reference only — no new files written there.

**Remaining for full wiki-only mode:**
- [ ] Verify proj-work redirect works end-to-end with 3+ features
- [ ] `wiki-query` reliably surfaces prior work from project work items
- [ ] `skillwiki lint` reports zero errors
- [ ] User confirms vault is sole canonical source
- [ ] Archive or delete `docs/superpowers/{specs,plans}/`
```

- [ ] **Step 6: Update description in frontmatter**

Replace line 3:
```
description: Reusable loop prompt for superpowers + skillwiki parallel dev workflow with /simplify gate, self-learning, and Hermes compat
```
With:
```
description: Reusable loop prompt for PRD-agnostic skillwiki dev workflow with proj-work redirect, /simplify gate, self-learning, and Hermes compat
```

- [ ] **Step 7: Update title**

Replace line 7:
```
# Dev Loop: Superpowers (PRD) + Skillwiki (Knowledge)
```
With:
```
# Dev Loop: PRD Skill + Skillwiki (Knowledge)
```

- [ ] **Step 8: Commit**

```bash
git add -A ~/.claude/projects/-Users-karlchow-Desktop-code-llm-wiki/memory/dev-loop-prompt.md
git commit -m "feat: update dev-loop-prompt to PRD-agnostic 9-step loop with proj-work redirect

Remove ingest steps (files now land in vault natively). Make PRD skill
pluggable (superpowers default, not required). Update cut-over status
to reflect active redirect pattern."
```

Note: the memory file lives outside the repo. If it's not tracked by git, skip the commit and just verify the file was written correctly.

---

### Task 3: Manual smoke test

**Files:** None (verification only)

- [ ] **Step 1: Read the updated proj-work SKILL.md and verify structure**

Run: `cat packages/skills/proj-work/SKILL.md`
Expected: "Redirect Output" section present between Steps and Stop conditions

- [ ] **Step 2: Read the updated dev-loop-prompt and verify structure**

Run: `cat ~/.claude/projects/-Users-karlchow-Desktop-code-llm-wiki/memory/dev-loop-prompt.md`
Expected: 9-step loop, no INGEST steps, PRD-agnostic language, updated rules

- [ ] **Step 3: Verify spec coverage**

For each section in the design spec (`docs/superpowers/specs/2026-05-04-proj-work-redirect-design.md`), confirm a corresponding task addresses it:
- "Changes → 1. proj-work SKILL.md" → Task 1 ✓
- "Changes → 2. Dev-loop-prompt" → Task 2 ✓
- "Backward Compatibility" → No code changes, verified in Task 2 rules ✓
- "Testing" → Task 3 ✓
