---
name: proj-decide
description: Write an Architectural Decision Record (ADR). If the decision generalizes, also create a concepts/ page.
---

# proj-decide

## Model routing

`proj-decide` authors architectural decisions and ADRs, so its companion
agent must run at the invoking main-agent model. Keep `model: inherit` in
`packages/skills/agents/proj-decide.md`; do not pin decision-making work to
`sonnet`, `haiku`, or `opus`. Do not add a `model` field to this `SKILL.md`
frontmatter.

## When to invoke
- User commits to an architectural decision worth recording for future reference.

## Pre-orientation reads
Standard four + project context.

## Steps
1. Resolve vault with `skillwiki path`. Draft the ADR **outside** the authoritative target path (temp file or work-item draft). Prefer frontmatter compatible with typed-knowledge architecture pages:
   - `type: concept`
   - `tags` include `adr` for newly created architecture pages
   - `provenance: project` or `mixed`
   - `provenance_projects` includes `[[{slug}]]`
   - Target path: `projects/{slug}/architecture/YYYY-MM-DD-{adr-slug}.md`
   - If no project context exists, default to `playground`.
2. Dry-run the managed Layer-3 publisher (read-only; emits an approval token):
   ```bash
   skillwiki project-page publish <draft> "$VAULT" \
     --project <slug> \
     --target projects/<slug>/architecture/YYYY-MM-DD-<adr-slug>.md \
     --log-note "<one-line note>"
   ```
   Review target state, draft SHA, prior target hash, and the returned `approval_token` with the human.
3. On human approval, publish with the exact token from the dry-run (do not re-author between dry-run and write):
   ```bash
   skillwiki project-page publish <draft> "$VAULT" \
     --project <slug> \
     --target projects/<slug>/architecture/YYYY-MM-DD-<adr-slug>.md \
     --log-note "<same one-line note>" \
     --write --approve <token>
   ```
4. Verify the touched page and project knowledge index (`projects/{slug}/knowledge.md`). Do **not** hand-edit root `index.md` for architecture pages — the publisher owns project knowledge projection.
5. **Generalization check.** If the decision applies beyond this project, draft a `concepts/` page with `provenance: project` (or `mixed` if research-informed) and publish it with `skillwiki page publish` (prefer `--approve` for this workstream).
6. Host-aware promotion:
   - Authorized Git leaf: `skillwiki sync` / `skillwiki sync push` after lint-delta.
   - Protected snapshotter (sg01): leave promotion to `wiki-snapshot.timer`; never author or push via `/root/wiki-git`.

## Stop conditions
- `project-page publish` dry-run or approved write exits non-zero.
- Approval token missing/mismatched — re-run dry-run; do not force a write.
- Host is a protected snapshotter and the operator asks to edit `/root/wiki-git` — refuse.

## Forbidden
- Direct writes into `projects/{slug}/architecture/` without `skillwiki project-page publish`.
- Hand-editing root `index.md` for architecture ADRs.
- Filing the concept page without explicit `provenance:`.
- Do not author, copy, edit, stage, commit, pull, reset, or push agent changes in `/root/wiki-git`.
- Running snapshot scripts or `git reset --hard` in the snapshot worktree as a publication shortcut.
