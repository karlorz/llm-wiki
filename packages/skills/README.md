# @skillwiki/skills

Prompt-only Markdown skills for Claude Code. Installed via `skillwiki install`
or the Claude/Codex/Antigravity plugin packaging paths.

Current package inventory: **18 skills**.

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
