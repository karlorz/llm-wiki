---
name: wiki-add-task
description: Capture ad-hoc ideas, bugs, tasks, or notes into the vault via /wiki-add-task or filesystem drop.
---

# wiki-add-task

Capture ad-hoc ideas, bugs, tasks, and notes into the vault. Three entry points depending on where you are:

| Entry | When | What happens |
|-------|------|-------------|
| `/wiki-add-task <text>` | You're in a Claude session | Appends entry to `raw/transcripts/YYYY-MM-DD-ad-hoc-captures.md` |
| Filesystem drop | You're NOT in a Claude session (Obsidian, editor, sync) | Create/edit any file in `raw/transcripts/` — dev-loop discovers it on next cycle |
| Dev-loop discovery | Automatic, next cycle | Scans `raw/transcripts/` for new files since last cycle, surfaces as claimable work |

## When This Skill Activates

- User invokes `/wiki-add-task` with a description.
- User says "add task", "capture this", "note this", "remember this", "log this idea", or similar.
- User provides a short text description and optionally a type tag.

## Output language

Run `skillwiki lang` at the start. Entry prose and `--human` summaries use the resolved language. Frontmatter keys, file names, and structural markers stay English.

## Steps

0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
1. **Parse arguments.** Extract from the user's message:
   - `text` — the idea/bug/task/note content (required)
   - `type` — one of: `idea`, `bug`, `task`, `note` (default: `idea`)
   - `project` — optional project slug to cross-reference (e.g., `llm-wiki`)
2. **Determine target file.** The capture file is `raw/transcripts/YYYY-MM-DD-ad-hoc-captures.md` where YYYY-MM-DD is today's date. If the file exists, append; otherwise create it with standard raw frontmatter.
3. **Write the entry.** Append to the capture file:
   ```markdown
   ### HH:MM — [type]

   [text]

   <!---meta: {"captured_at": "YYYY-MM-DDTHH:MM:SS", "type": "[type]"}--->
   ```
   - Use 24-hour time for HH:MM.
   - Do not overwrite or modify existing entries.
4. **Cross-reference (optional).** If a `project` slug was provided:
   - Check that `projects/{slug}/` exists in the vault.
   - Append a one-line reference to the project's work log or compound notes:
     `- [YYYY-MM-DD] capture: [text] → raw/transcripts/YYYY-MM-DD-ad-hoc-captures.md`
   - Do NOT create a full work item (that's `proj-work`'s job).
5. **Update log.md.** Append: `## [YYYY-MM-DD] capture | [type]: [text (first 60 chars)]`
6. **Confirm to user.** Report what was captured and where. Suggest next steps:
   - If `type: idea` → "Consider ingesting related sources to develop this idea."
   - If `type: bug` → "Use proj-work to create a bug-fix work item."
   - If `type: task` → "Use proj-work to track this task through the dev loop."
   - If `type: note` → "Will be available for future wiki-query searches."

## Ad-hoc captures file format

The file `raw/transcripts/YYYY-MM-DD-ad-hoc-captures.md` is a standard raw source with frontmatter:

```yaml
---
source_url:
ingested: YYYY-MM-DD
sha256:
---
```

The `sha256` is computed over the body after the closing `---`. On each append, recompute and update `sha256`. This keeps source-drift detection functional even though the file grows throughout the day.

## Stop conditions

- `skillwiki path` returns NO_VAULT_CONFIGURED.
- No `text` provided (prompt user once, then stop).

## Forbidden

- Creating an `inbox/` directory. All captures go to `raw/transcripts/`.
- Modifying existing entries in the captures file — only append.
- Creating a work item — this is capture-only. Use `proj-work` for full work items.
- Writing to any Layer 2 or Layer 3 location. Captures are Layer 1 (raw).

## Filesystem drop (offline capture)

When you're not in a Claude session, drop files directly into `raw/transcripts/`:

1. Create any `.md` file in `raw/transcripts/` — name it descriptively (e.g., `2026-05-07-idea-xyz.md`)
2. Add raw frontmatter at the top:
   ```yaml
   ---
   source_url:
   ingested: YYYY-MM-DD
   sha256:
   ---
   ```
3. Write your idea/bug/task/note below the frontmatter

No special format required — the dev-loop QUERY step will discover new files on the next cycle and surface them as claimable work. Mark the type with a heading like `## idea`, `## bug`, `## task`, or just write freeform.

## Dev-loop discovery

When the dev-loop QUERY step runs, it should scan `raw/transcripts/` for files with `ingested:` date newer than the last cycle. New files are surfaced as claimable work items. The agent then decides whether to:
- Create a work item via `proj-work` (for tasks and bugs)
- Ingest as a knowledge page via `wiki-ingest` (for ideas with sources)
- Leave in place (for notes that don't need action yet)
