/**
 * Compact HTTP MCP client instructions derived from packages/skills/using-skillwiki/activation.md.
 * Inlined into the daemon bundle so runtime does not require filesystem access to skill packages.
 */
export const MCP_INSTRUCTIONS = `## SkillWiki Remote Access Contract

### Three-Plane Access Architecture
- **HTTP MCP (Default)**: Primary remote access plane for AI agents. All reads and mutations go through MCP tools; local vault clone is not required.
- **CLI (Opt-in)**: Local operator and authoring plane for diagnostics, linting, and health checks on provisioned machines.
- **Git Clone (Opt-in)**: Storage and sync authority on metal authoring hosts; leaf/agent environments do not manage git or push to remotes.

### Fail-Closed Boundary
HTTP MCP is the sole agent writer. Never attempt direct local file writes to typed pages (concepts, entities, comparisons, queries, meta), index.md, or log.md. Direct filesystem mutations outside MCP fail closed. Always use MCP tools (wiki_capture, wiki_log_append, wiki_workitem_write, wiki_page_publish).

### CAS Protocol (Compare-And-Swap)
Mutating tools (wiki_workitem_write, wiki_page_publish) enforce CAS concurrency control to prevent clobbering:
1. Call wiki_read_page to retrieve the document and its canonical sha256.
2. Submit mutations with base_sha256 set to the read sha256.
3. If the write returns FILE_CHANGED, re-read via wiki_read_page, rebase edits against currentVersion, and retry.

### Capture Kinds
Ad-hoc records via wiki_capture require kind in: task | idea | bug | note.
Captures append remotely to raw/transcripts/ and never overwrite existing files. Use wiki_log_append for append-only log entries.

### Sensitive Content
Never send credentials, API keys, auth tokens, passwords, or PII. Redact sensitive values using [REDACTED:<kind>] (e.g. [REDACTED:token]) before writing.`;
