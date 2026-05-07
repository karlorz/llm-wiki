---
name: wiki-add-task
description: Capture ad-hoc ideas, bugs, tasks, or notes into the vault without leaving the current workflow.
---

# wiki-add-task

Quick-capture skill for ad-hoc ideas, bugs, tasks, and notes. Writes directly to `raw/transcripts/` — the vault's designated ad-hoc capture point (Layer 1). No new directories or inbox folders needed.

## When This Skill Activates

- User wants to quickly jot down an idea, bug, task, or note without interrupting their current workflow.
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
