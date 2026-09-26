/**
 * Compact HTTP MCP client instructions derived from packages/skills/using-skillwiki/activation.md.
 * Inlined into the daemon bundle so runtime does not require filesystem access to skill packages.
 */
export const MCP_INSTRUCTIONS = `## SkillWiki Remote Access Contract

### Three-Plane Access Architecture
HTTP MCP is the default agent plane. CLI is an opt-in operator plane; Git clone
is storage authority on authoring hosts. Leaf agents do not manage vault git.

### Fail-Closed Boundary
HTTP MCP is the sole managed writer. Use \`wiki_capture\`, \`wiki_log_append\`,
\`wiki_workitem_write\`, or \`wiki_page_publish\`; never write typed pages,
\`index.md\`, or \`log.md\` directly.

### Vault Selection
For the usual vault, omit \`vault\` and use the live handshake's \`default_vault\`.
Set \`vault\` only when an extra vault was explicitly requested. Before reporting
a write as saved, check its successful receipt's \`vault_id\` against the intended
vault.

### CAS Protocol (Compare-And-Swap)
For \`wiki_workitem_write\` or \`wiki_page_publish\`, read first, send the returned
sha256 as \`base_sha256\`, and on \`FILE_CHANGED\` re-read, rebase, and retry.

### Capture Kinds
\`wiki_capture\` kind is \`task | idea | bug | note\`. Captures append to
\`raw/transcripts/\`. Verify its returned \`path\` with \`wiki_read_page\`.
\`wiki_log_append\` is append-only; verify its \`event_path\` with \`wiki_read_page\`.
Use \`tail_bytes\` for large pages.

### Sensitive Content
Never send secrets or personal information. Use \`[REDACTED:<kind>]\`.`;
