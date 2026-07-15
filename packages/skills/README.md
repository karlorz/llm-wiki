# @skillwiki/skills

Prompt-only Markdown skills for Claude Code. Installed via `skillwiki install`
or the Claude/Codex/Antigravity plugin packaging paths.

Current package inventory: **18 skills**.

Publication policy: new or updated typed-knowledge and meta pages must use
`skillwiki page publish` from a temporary draft, inspect its dry-run, and add
`--write` only after the preview succeeds. Do not directly publish the final
typed path or separately edit its index/log entries; immutable raw sources and
non-typed project work retain their existing workflows.

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit`, `wiki-archive`, `wiki-reingest`, `wiki-adapter-prd`, `wiki-add-task`, `wiki-sync`, `wiki-canvas`, `wiki-gate-plan-mode` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |
| onboarding | `using-skillwiki` |

Verify the live inventory from source:

```bash
find packages/skills -mindepth 2 -maxdepth 2 -name SKILL.md -print | sort
bash scripts/verify-manifests.sh
```

Each top-level skill subdirectory holds one canonical `SKILL.md`. The nested
`skills/<skill>/SKILL.md` tree mirrors those files for Codex plugin discovery;
keep it byte-for-byte in sync with the canonical top-level files.

Codex installs through `packages/codex-skills`, a materialized plugin root that
copies this package's `.codex-plugin/` manifest, `skills/` mirror, and
Codex-specific hook files. That root exposes `hooks/hooks-codex.json` and
`hooks/session-start-codex` without exposing the Claude default
`hooks/hooks.json`.

Run `npm run materialize:plugins` from the repository root after changing
canonical skill, agent, or hook assets. Run
`npm run materialize:plugins:check` for read-only drift detection.

The sibling `vault-sync` plugin ships six additional operational skills under
`packages/vault-sync/skills/` and is packaged separately from this skill set.


## Managed Vault Mutation Contract

Before a managed vault mutation, invoke the managed SkillWiki command while the draft remains outside the authoritative target path. The command resolves fleet authority, refuses existing unmerged/review-required state, converges an authorized Git writer, freezes the base OID, and only then applies the write. Do not run `git pull --rebase --autostash` after placing the authoritative change in the live worktree. Do not edit root `index.md` or root `log.md` directly; projection and log commands own those compatibility files.

- typed pages: `skillwiki page publish <draft> <vault> --target <path>` then the same command with `--write`
- archive: `skillwiki archive <path> <vault>`
- ad-hoc structural log: `skillwiki log-append <vault> --content '<entry>'` (Release A dual-write) or event materialization (Release B)
- project/root index: `skillwiki project-index <slug> <vault> --apply` and `skillwiki index rebuild <vault> --write` only through managed commands
- log projection: `skillwiki log materialize <vault> [--write]`
- paired projections: `skillwiki projections materialize <vault> [--write]`

