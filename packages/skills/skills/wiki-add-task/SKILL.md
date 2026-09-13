---
name: wiki-add-task
description: Capture ad-hoc ideas, bugs, tasks, or notes into the vault (HTTP MCP wiki_capture on leaf hosts; local raw/transcripts/ on authoring hosts).
---
# wiki-add-task
Capture ad-hoc ideas, bugs, tasks, and notes into the vault. Destination of captures remains vault `raw/transcripts/`. Entry points depend on host role and environment:
| Entry | When | What happens |
|-------|------|-------------|
| MCP `wiki_capture` | SkillWiki MCP namespace is loaded and ready | Maps to `wiki_capture(kind, project, title, content)`; server writes `raw/transcripts/` remotely |
| `/wiki-add-task <text>` | Interactive session on an authoring host (MCP absent) | Creates `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md` with ad-hoc capture frontmatter |
| Filesystem drop | Hermes Agent compact mode on an authoring host | Fallback — create `.md` in `raw/transcripts/`, dev-loop discovers it |
| Filesystem drop | Not in a Claude session (Obsidian, editor, sync) on an authoring host | Fallback — create a new `.md` file in `raw/transcripts/` using vault template; dev-loop discovers it on next cycle |
| Dev-loop discovery | Automatic, next cycle (authoring-host / leftover-transition only) | Scans `raw/transcripts/` for new files since last cycle, surfaces as claimable work |
**Path Rule:** Destination of captures is vault `raw/transcripts/` (Layer 1). Frozen-leaf hosts capture via MCP `wiki_capture` (server writes `raw/transcripts/` remotely); local file writes only occur on authoring hosts. Never capture under `projects/{slug}/raw/` — that violates SCHEMA.md Layer 1 immutability. Text captures stay in `raw/transcripts/`. If the capture includes images or other binaries, store those files under `raw/assets/` with a sibling Markdown note that embeds them; never use a .txt sidecar (such as `README.txt`) as the only index; Obsidian opens Markdown notes.
### Exception: Explicit project task requests
When the user explicitly says "raise task to project X", "add a task for X", "create a feature request for X", or uses a directive structure like "raise task to {project} {description}", the intent is a **work item**, not a capture:
| User wording | Action | Target |
|---|---|---|
| "capture this", "note this", "remember this" | Leaf: MCP `wiki_capture`; Authoring: wiki-add-task | `raw/transcripts/` (leaf writes via `wiki_capture`, authoring writes local file) |
| "raise task to project X", "add task to X project" | Escalate to `proj-work` | `projects/{slug}/work/YYYY-MM-DD-{slug}/task.md` |
| "save to wiki" + content | Use `wiki-ingest` | `concepts/`, `entities/`, etc. |
This is NOT a violation of the rule below — explicit project task requests are a distinct user intent that bypasses raw capture and goes directly to a Layer 3 work item.
## When This Skill Activates
- User invokes `/wiki-add-task` with a description.
- User says "add task", "capture this", "note this", "remember this", "log this idea", or similar.
- User provides a short text description and optionally a type tag.
- **Precedence:** If SkillWiki MCP tools are available (`wiki_capture`), **skillwiki-mcp / wiki_capture wins**. Do not race to local writes. The local-write path in wiki-add-task is only when MCP is absent AND the host is an authoring host (not a frozen leaf).
- **Do NOT activate** when the user says "raise task to project X" or "add work item to project X" — escalate to `proj-work` instead.
## Output language
Run `skillwiki lang` at the start. Entry prose and `--human` summaries use the resolved language. Frontmatter keys, file names, and structural markers stay English.
## Steps
0. **Resolve environment and host role.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`. Check if SkillWiki MCP namespace (`wiki_capture`) is available or if running on a leaf host.
   - **On frozen-leaf hosts:** Captures MUST go through MCP `wiki_capture`. If MCP is missing or returns 401, STOP and report (see Stop conditions); never fall back to local file writes.
   - **Precedence:** If SkillWiki MCP namespace is loaded and ready, execute via **MCP Mode (Step A)**.
   - **Authoring host local write:** Only when MCP is absent AND running on an authoring host, execute via **Local Write Mode (Step B)**.

### Step A: MCP Mode (Leaf hosts / MCP available)
1. **Parse arguments.** Extract from the user's message:
- `text` — the idea/bug/task/note content (required)
- `kind` — map user type (`idea`, `bug`, `task`, `note`) to `kind` (default: `idea`)
- `project` — optional project slug to cross-reference (e.g., `llm-wiki`)
- `title` — derive from first ~6 words of `text`
2. **Sensitive content guard.** Before sending capture, scan the text for live credentials, access keys, tokens, passwords, cookies, bearer headers, or private keys. Redact before writing. If the source text itself contains a live secret that must be preserved verbatim, STOP instead of filing it.
3. **Call `wiki_capture`.** Invoke MCP `wiki_capture(kind, project, title, content)`.
   - Do NOT build a local filename.
   - Do NOT write local frontmatter.
   - Do NOT append to local `log.md` on leaf hosts.
4. **Structural log (optional).** Call MCP `wiki_log_append` only when a structural log line is genuinely needed. The MCP server owns the structural log; do not dual-write.
5. **Confirm to user.** Report the capture confirmation using the path returned by MCP `wiki_capture`. Suggest next steps:
- If `kind: idea` → "Consider ingesting related sources to develop this idea."
- If `kind: bug` → "Use proj-work to create a bug-fix work item."
- If `kind: task` → "Use proj-work to track this task through the dev loop."
- If `kind: note` → "Will be available for future wiki-query searches."

### Step B: Local Write Mode (Authoring hosts only, when MCP absent)
1. **Parse arguments.** Extract from the user's message:
- `text` — the idea/bug/task/note content (required)
- `type` — one of: `idea`, `bug`, `task`, `note` (default: `idea`)
- `project` — optional project slug to cross-reference (e.g., `llm-wiki`)
2. **Sensitive content guard.** Before writing a capture, scan the text for live credentials, access keys, tokens, passwords, cookies, bearer headers, or private keys. Redact before writing. If the source text itself contains a live secret that must be preserved verbatim, STOP instead of filing it.
3. **Build filename.** Derive a slug from the first ~6 words of the text (lowercased, hyphens for spaces, non-alphanumeric stripped). The capture file is `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md`. Each capture gets its own file — never append to an existing file.
4. **Write frontmatter.** Create the file with ad-hoc capture frontmatter:
```yaml
---
source_url:
ingested: YYYY-MM-DD
kind: {type}
project: "[[{slug}]]"
---
```
- Set `kind` to the parsed type (`idea`, `bug`, `task`, `note`).
- If a `project` slug was provided, set `project: "[[slug]]"`.
- If no project, omit the `project` field entirely.
- `source_url` is null (these are locally originated captures).
- `sha256` may be omitted for locally originated captures, but the completed capture is still immutable evidence. Corrections create a new capture or a maintained work-item note; never rewrite the existing transcript.
5. **Write body.** Below the frontmatter, write:
```markdown
# {type}: {text}
{text}
```
Use the resolved output language for any prose. The type label and frontmatter stay English.
6. **Cross-reference (optional).** If a `project` slug was provided:
- Check that `projects/{slug}/` exists in the vault.
- Append a one-line reference to the project's compound notes:
`- [YYYY-MM-DD] capture: [text (first 60 chars)] → raw/transcripts/YYYY-MM-DD-{type}-{slug}.md`
- Do NOT create a full work item (that's `proj-work`'s job).
7. **Update log.md.** Append: `## [YYYY-MM-DD] capture | [type]: [text (first 60 chars)]`
8. **Confirm to user.** Report what was captured and where. Suggest next steps:
- If `type: idea` → "Consider ingesting related sources to develop this idea."
- If `type: bug` → "Use proj-work to create a bug-fix work item."
- If `type: task` → "Use proj-work to track this task through the dev loop."
- If `type: note` → "Will be available for future wiki-query searches."
## Capture file format
Each capture is a standalone file with ad-hoc capture frontmatter:
```yaml
---
source_url:
ingested: 2026-05-08
kind: idea
project: "[[llm-wiki]]"
---
# idea: Fix the template mismatch
Fix the template mismatch between wiki-add-task and the vault template.
```
The `kind` field uses the capture type and must be one of: `idea`, `bug`, `task`, `note` (plus the existing `postmortem`, `session-log`, `meeting-notes`, `other` for non-capture raw sources).
The `project` and `kind` fields can be set independently — they do not require `work_item`. The `work_item` field is only used when the raw source is directly tied to a project work item (set by `proj-work`).
Ad-hoc captures may omit `sha256`; omission does not grant mutation authority. Once created, the transcript's content and frontmatter are immutable. The `sha256` field remains required for ingest pipelines that provide integrity verification.
## Stop conditions
- On frozen-leaf hosts: MCP namespace missing, unauthenticated (401), or `missing_prereq` (STOP and report; never fallback to local `raw/transcripts/` writes).
- `skillwiki path` returns NO_VAULT_CONFIGURED.
- No `text` provided (prompt user once, then stop).
- Target file already exists (use a different slug or add a suffix).
- Capture text contains unredacted live credentials or other authenticating secrets.
## Forbidden
- On frozen-leaf hosts, writing local `raw/transcripts/` or `log.md`.
- Creating an `inbox/` directory. All captures go to `raw/transcripts/`.
- Appending to existing capture files — each capture gets its own file.
- Editing or correcting an existing raw transcript; create a new capture or maintained work-item note instead.
- Creating a work item — this is capture-only. Use `proj-work` for full work items.
- Writing to any Layer 2 or Layer 3 location. Captures are Layer 1 (raw).
- Writing live credentials, access keys, tokens, passwords, cookies, bearer headers, private keys, or other authenticating secrets to the vault.
- Indexing `raw/assets/` binaries with only a `.txt` sidecar.
## Filesystem drop (offline capture — authoring hosts only)
When you're not in a Claude session on an authoring host, drop files directly into `raw/transcripts/`:
1. Create a `.md` file in `raw/transcripts/` — name it descriptively (e.g., `2026-05-08-idea-fix-template.md`)
2. Use ad-hoc capture frontmatter: `source_url:`, `ingested:`, `kind:`, and optionally `project:`
3. Write your idea/bug/task/note below the frontmatter
No special format required — the dev-loop QUERY step will discover new files on the next cycle and surface them as claimable work. Mark the type with a heading like `## idea`, `## bug`, `## task`, or just write freeform.
## Dev-loop discovery (authoring hosts / leftover transition)
When the dev-loop QUERY step runs on an authoring host, it should scan `raw/transcripts/` for files with `ingested:` date newer than the last cycle. New files are surfaced as claimable work items. The agent then decides whether to:
- Create a work item via `proj-work` (for tasks and bugs)
- Ingest as a knowledge page via `wiki-ingest` (for ideas with sources)
- Leave in place (for notes that don't need action yet)
