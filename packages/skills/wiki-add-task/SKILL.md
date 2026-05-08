---
name: wiki-add-task
description: Capture ad-hoc ideas, bugs, tasks, or notes into the vault via /wiki-add-task or filesystem drop.
---

# wiki-add-task

Capture ad-hoc ideas, bugs, tasks, and notes into the vault. Three entry points depending on where you are:

| Entry | When | What happens |
|-------|------|-------------|
| `/wiki-add-task <text>` | You're in a Claude session | Creates `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md` with raw-valid frontmatter |
| Filesystem drop | You're NOT in a Claude session (Obsidian, editor, sync) | Create any `.md` file in `raw/transcripts/` using the vault template — dev-loop discovers it on next cycle |
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
2. **Build filename.** Derive a short slug from the text (lowercase, hyphenated, max 8 words). The capture file is `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md`. Each capture gets its own file — never append to an existing file.
3. **Write frontmatter.** Create the file with raw-source frontmatter:
   ```yaml
   ---
   source_url:
   ingested: YYYY-MM-DD
   ingested_by: manual
   sha256:
   kind: {type}
   project: "[[{slug}]]"
   ---
   ```
   - Set `kind` to the parsed type (`idea`, `bug`, `task`, `note`).
   - If a `project` slug was provided, set `project: "[[slug]]"`.
   - If no project, omit the `project` field entirely.
   - Leave `sha256` empty for now — step 5 fills it in.
   - `source_url` is null (these are locally originated captures).
4. **Write body.** Below the frontmatter, write:
   ```markdown
   # {type}: {text}

   {text}
   ```
   Use the resolved output language for any prose. The type label and frontmatter stay English.
5. **Compute and write sha256.** Run `skillwiki hash <file>` to get the SHA-256 of the body. Update the `sha256:` field in the frontmatter with the computed value. This makes the file validate as a raw source.
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

Each capture is a standalone raw source file with valid frontmatter:

```yaml
---
source_url:
ingested: 2026-05-08
ingested_by: manual
sha256: <64-char hex computed over body>
kind: idea
project: "[[llm-wiki]]"
---

# idea: Fix the template mismatch

Fix the template mismatch between wiki-add-task and the vault template.
```

The `kind` field uses the capture type and must be one of: `idea`, `bug`, `task`, `note` (plus the existing `postmortem`, `session-log`, `meeting-notes`, `other` for non-capture raw sources).

The `project` and `kind` fields can be set independently — they do not require `work_item`. The `work_item` field is only used when the raw source is directly tied to a project work item (set by `proj-work`).

## Stop conditions

- `skillwiki path` returns NO_VAULT_CONFIGURED.
- No `text` provided (prompt user once, then stop).
- Target file already exists (use a different slug or add a suffix).

## Forbidden

- Creating an `inbox/` directory. All captures go to `raw/transcripts/`.
- Appending to existing capture files — each capture gets its own file.
- Creating a work item — this is capture-only. Use `proj-work` for full work items.
- Writing to any Layer 2 or Layer 3 location. Captures are Layer 1 (raw).

## Filesystem drop (offline capture)

When you're not in a Claude session, drop files directly into `raw/transcripts/`:

1. Create a `.md` file in `raw/transcripts/` — name it descriptively (e.g., `2026-05-08-idea-fix-template.md`)
2. Use the vault template at `_Templates/tpl-ad-hoc-capture.md` for frontmatter scaffolding
3. Write your idea/bug/task/note below the frontmatter
4. Run `skillwiki hash <file>` when you're back in a session to fill in sha256

No special format required — the dev-loop QUERY step will discover new files on the next cycle and surface them as claimable work. Mark the type with a heading like `## idea`, `## bug`, `## task`, or just write freeform.

## Dev-loop discovery

When the dev-loop QUERY step runs, it should scan `raw/transcripts/` for files with `ingested:` date newer than the last cycle. New files are surfaced as claimable work items. The agent then decides whether to:
- Create a work item via `proj-work` (for tasks and bugs)
- Ingest as a knowledge page via `wiki-ingest` (for ideas with sources)
- Leave in place (for notes that don't need action yet)
