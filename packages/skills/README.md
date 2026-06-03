# @skillwiki/skills

Prompt-only Markdown skills for Claude Code. Installed via `skillwiki install`.

| Namespace | Skills |
|---|---|
| `wiki-*` | `wiki-init`, `wiki-ingest`, `wiki-query`, `wiki-lint`, `wiki-crystallize`, `wiki-audit` |
| `proj-*` | `proj-init`, `proj-work`, `proj-distill`, `proj-decide` |

Each top-level skill subdirectory holds one canonical `SKILL.md`. The nested
`skills/<skill>/SKILL.md` tree mirrors those files for Codex plugin discovery;
keep it byte-for-byte in sync with the canonical top-level files.

Codex installs through `packages/codex-skills`, a materialized plugin root that
copies this package's `.codex-plugin/` manifest, `skills/` mirror, and
Codex-specific hook files. That root exposes `hooks/hooks-codex.json` and
`hooks/session-start-codex` without exposing the Claude default
`hooks/hooks.json`.
