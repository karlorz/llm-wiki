# SkillWiki Activation

SkillWiki is the project-aware knowledge base and skill suite. This file is
session-start routing context; invoke `using-skillwiki` for full instructions.

## Route

Use SkillWiki for vault or wiki work: setup, capture, ingestion, search, health,
provenance, lifecycle, project workspaces, decisions, sync, or graphing.
Choose the matching installed skill:

- Setup and input: `wiki-init`, `wiki-ingest`, `wiki-add-task`,
  `wiki-adapter-prd`, `skillwiki-connect`.
- Read and maintain: `wiki-query`, `wiki-lint`, `wiki-audit`,
  `wiki-crystallize`, `wiki-reingest`, `wiki-archive`, `wiki-remove`.
- Projects and planning: `proj-init`, `proj-work`, `proj-distill`,
  `proj-decide`, `wiki-gate-plan-mode`, `dev-loop:research`.
- Fleet and visualization: `wiki-sync`, `wiki-canvas`.
- HTTP MCP capture or append: `skillwiki-mcp`.

If routing is unclear, invoke `using-skillwiki` rather than guessing.

## CLI and Planning

If `skillwiki --help` fails, use local tools only for read-only inspection and
fail closed for managed mutations.

After architectural design approval, invoke `proj-work` and put `spec.md` in
that work item. Do not invoke `writing-plans`. Do not git commit from
brainstorming. Use standalone `test-driven-development` for bounded TDD. For UI
work, offer `visual-companion.md` once. Never create `docs/superpowers/`.

Workflow profiles are `native`, `guided`, and explicit-only `full`; selection
is `adaptive` or `fixed`. Installation or cache discovery proves availability,
not activation. Native and guided do not force Superpowers or plan-mode gating.
Only a full profile may use its configured provider flow. Invalid fixed policy
fails closed; noninteractive sessions do not prompt. Keep workflow profile,
PRD provider and stage, SkillWiki provenance, and simplify review independent.

## Managed-Write Safety

The HTTP MCP contract below controls remote reads and mutations. On leaf hosts,
captures use MCP, never local `raw/transcripts` or `log.md` writes. Project
workspace writes use `wiki_workitem_write` with compare-and-swap; stop if the
tool or path family is unavailable. A wiki push or rclone copy is not a managed
write and is not visible until the authoritative snapshot. Never use bare `rm`
or `git rm` for fleet deletion. Never auto-install SkillWiki in unattended
sessions. If required publish support is unavailable, fail closed.

Never send secrets, credentials, tokens, passwords, or personal information.
Redact with `[REDACTED:<kind>]`.

<!-- mcp-instructions:begin -->
## SkillWiki Remote Access Contract

### Three-Plane Access Architecture
HTTP MCP is the default agent plane. CLI is an opt-in operator plane; Git clone
is storage authority on authoring hosts. Leaf agents do not manage vault git.

### Fail-Closed Boundary
HTTP MCP is the sole managed writer. Use `wiki_capture`, `wiki_log_append`,
`wiki_workitem_write`, or `wiki_page_publish`; never write typed pages,
`index.md`, or `log.md` directly.

### CAS Protocol (Compare-And-Swap)
For `wiki_workitem_write` or `wiki_page_publish`, read first, send the returned
sha256 as `base_sha256`, and on `FILE_CHANGED` re-read, rebase, and retry.

### Capture Kinds
`wiki_capture` kind is `task | idea | bug | note`. Captures append to
`raw/transcripts/`. Verify the returned `event_path` with `wiki_read_page`;
`wiki_log_append` is append-only. Use `tail_bytes` for large pages.

### Sensitive Content
Never send secrets or personal information. Use `[REDACTED:<kind>]`.
<!-- mcp-instructions:end -->

## Drift and Canonical Paths

If `skillwiki doctor` reports a newer version, invoke `using-skillwiki` again.
The full source skill is `packages/skills/using-skillwiki/SKILL.md`; resolve the
vault with `skillwiki path`. Frontier project agents are installed under the
plugin root with `model: inherit`.
