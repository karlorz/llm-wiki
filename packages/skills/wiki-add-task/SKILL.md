     1|     1|---
     2|     2|version: 0.2.2
     3|     3|name: wiki-add-task
     4|     4|description: Capture ad-hoc ideas, bugs, tasks, or notes into the vault with ad-hoc capture frontmatter and descriptive filenames.
     5|     5|---
     6|     6|
     7|     7|# wiki-add-task
     8|     8|
     9|     9|Capture ad-hoc ideas, bugs, tasks, and notes into the vault. Three entry points depending on where you are:
    10|    10|
    11|    11|| Entry | When | What happens |
    12|    12||-------|------|-------------|
    13|    13|| `/wiki-add-task <text>` | You're in a Claude Code session (NOT Hermes compact) | Creates `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md` with ad-hoc capture frontmatter |
    14|    14|| `skillwiki add-task <text>` | Hermes Agent compact mode | Same as above — compact-compatible CLI trigger |
    15|    15|| Filesystem drop | You're NOT in a Claude session (Obsidian, editor, sync) | Create any `.md` file in `raw/transcripts/` using the vault template — dev-loop discovers it on next cycle |
    16|    16|| Dev-loop discovery | Automatic, next cycle | Scans `raw/transcripts/` for new files since last cycle, surfaces as claimable work |
    17|    17|
    18|    18|**Path Rule:** Captures ALWAYS go to `$(skillwiki path)/raw/transcripts/` (Layer 1). Never under `projects/{slug}/raw/` — that violates SCHEMA.md Layer 1 immutability.
    19|    19|
    20|    20|### Exception: Explicit project task requests
    21|    21|
    22|    22|When the user explicitly says "raise task to project X", "add a task for X", "create a feature request for X", or uses a directive structure like "raise task to {project} {description}", the intent is a **work item**, not a capture:
    23|    23|
    24|    24|| User wording | Action | Target |
    25|    25||---|---|---|
    26|    26|| "capture this", "note this", "remember this" | Use wiki-add-task (this skill) | `raw/transcripts/` |
    27|    27|| "raise task to project X", "add task to X project" | Escalate to `proj-work` | `projects/{slug}/work/YYYY-MM-DD-{slug}/task.md` |
    28|    28|| "save to wiki" + content | Use `wiki-ingest` | `concepts/`, `entities/`, etc. |
    29|    29|
    30|    30|This is NOT a violation of the "ALWAYS" rule below — explicit project task requests are a distinct user intent that bypasses raw capture and goes directly to a Layer 3 work item.
    31|    31|
    32|    32|## When This Skill Activates
    33|    33|
    34|    34|- User invokes `/wiki-add-task` with a description.
    35|    35|- User says "add task", "capture this", "note this", "remember this", "log this idea", or similar.
    36|    36|- User provides a short text description and optionally a type tag.
    37|    37|- **Do NOT activate** when the user says "raise task to project X" or "add work item to project X" — escalate to `proj-work` instead.
    38|    38|
    39|    39|## Output language
    40|    40|
    41|    41|Run `skillwiki lang` at the start. Entry prose and `--human` summaries use the resolved language. Frontmatter keys, file names, and structural markers stay English.
    42|    42|
    43|    43|## Steps
    44|    44|
    45|    45|0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
    46|    46|1. **Parse arguments.** Extract from the user's message:
    47|    47|   - `text` — the idea/bug/task/note content (required)
    48|    48|   - `type` — one of: `idea`, `bug`, `task`, `note` (default: `idea`)
    49|    49|   - `project` — optional project slug to cross-reference (e.g., `llm-wiki`)
    50|    50|2. **Build filename.** Derive a slug from the first ~6 words of the text (lowercased, hyphens for spaces, non-alphanumeric stripped). The capture file is `raw/transcripts/YYYY-MM-DD-{type}-{slug}.md`. Each capture gets its own file — never append to an existing file.
    51|    51|3. **Write frontmatter.** Create the file with ad-hoc capture frontmatter:
    52|    52|   ```yaml
    53|    53|   ---
    54|    54|   source_url:
    55|    55|   ingested: YYYY-MM-DD
    56|    56|   kind: {type}
    57|    57|   project: "[[{slug}]]"
    58|    58|   ---
    59|    59|   ```
    60|    60|   - Set `kind` to the parsed type (`idea`, `bug`, `task`, `note`).
    61|    61|   - If a `project` slug was provided, set `project: "[[slug]]"`.
    62|    62|   - If no project, omit the `project` field entirely.
    63|    63|   - `source_url` is null (these are locally originated captures).
    64|    64|   - No `sha256` — ad-hoc captures are mutable working notes, not immutable sources.
    65|    65|4. **Write body.** Below the frontmatter, write:
    66|    66|   ```markdown
    67|    67|   # {type}: {text}
    68|    68|
    69|    69|   {text}
    70|    70|   ```
    71|    71|   Use the resolved output language for any prose. The type label and frontmatter stay English.
    72|    72|5. **Cross-reference (optional).** If a `project` slug was provided:
    73|    73|   - Check that `projects/{slug}/` exists in the vault.
    74|    74|   - Append a one-line reference to the project's compound notes:
    75|    75|     `- [YYYY-MM-DD] capture: [text (first 60 chars)] → raw/transcripts/YYYY-MM-DD-{type}-{slug}.md`
    76|    76|   - Do NOT create a full work item (that's `proj-work`'s job).
    77|    77|6. **Update log.md.** Append: `## [YYYY-MM-DD] capture | [type]: [text (first 60 chars)]`
    78|    78|7. **Confirm to user.** Report what was captured and where. Suggest next steps:
    79|    79|   - If `type: idea` → "Consider ingesting related sources to develop this idea."
    80|    80|   - If `type: bug` → "Use proj-work to create a bug-fix work item."
    81|    81|   - If `type: task` → "Use proj-work to track this task through the dev loop."
    82|    82|   - If `type: note` → "Will be available for future wiki-query searches."
    83|    83|
    84|    84|## Capture file format
    85|    85|
    86|    86|Each capture is a standalone file with ad-hoc capture frontmatter:
    87|    87|
    88|    88|```yaml
    89|    89|---
    90|    90|source_url:
    91|    91|ingested: 2026-05-08
    92|    92|kind: idea
    93|    93|project: "[[llm-wiki]]"
    94|    94|---
    95|    95|
    96|    96|# idea: Fix the template mismatch
    97|    97|
    98|    98|Fix the template mismatch between wiki-add-task and the vault template.
    99|    99|```
   100|   100|
   101|   101|The `kind` field uses the capture type and must be one of: `idea`, `bug`, `task`, `note` (plus the existing `postmortem`, `session-log`, `meeting-notes`, `other` for non-capture raw sources).
   102|   102|
   103|   103|The `project` and `kind` fields can be set independently — they do not require `work_item`. The `work_item` field is only used when the raw source is directly tied to a project work item (set by `proj-work`).
   104|   104|
   105|   105|Ad-hoc captures omit `sha256` — they are mutable working notes, not immutable sources. The `sha256` field is reserved for ingested raw sources that require integrity verification.
   106|   106|
   107|   107|## Stop conditions
   108|   108|
   109|   109|- `skillwiki path` returns NO_VAULT_CONFIGURED.
   110|   110|- No `text` provided (prompt user once, then stop).
   111|   111|- Target file already exists (use a different slug or add a suffix).
   112|   112|
   113|   113|## Forbidden
   114|   114|
   115|   115|- Creating an `inbox/` directory. All captures go to `raw/transcripts/`.
   116|   116|- Appending to existing capture files — each capture gets its own file.
   117|   117|- Creating a work item — this is capture-only. Use `proj-work` for full work items.
   118|   118|- Writing to any Layer 2 or Layer 3 location. Captures are Layer 1 (raw).
   119|   119|
   120|   120|## Filesystem drop (offline capture)
   121|   121|
   122|   122|When you're not in a Claude session, drop files directly into `raw/transcripts/`:
   123|   123|
   124|   124|1. Create a `.md` file in `raw/transcripts/` — name it descriptively (e.g., `2026-05-08-idea-fix-template.md`)
   125|   125|2. Use ad-hoc capture frontmatter: `source_url:`, `ingested:`, `kind:`, and optionally `project:`
   126|   126|3. Write your idea/bug/task/note below the frontmatter
   127|   127|
   128|   128|No special format required — the dev-loop QUERY step will discover new files on the next cycle and surface them as claimable work. Mark the type with a heading like `## idea`, `## bug`, `## task`, or just write freeform.
   129|   129|
   130|   130|## Dev-loop discovery
   131|   131|
   132|   132|When the dev-loop QUERY step runs, it should scan `raw/transcripts/` for files with `ingested:` date newer than the last cycle. New files are surfaced as claimable work items. The agent then decides whether to:
   133|   133|- Create a work item via `proj-work` (for tasks and bugs)
   134|   134|- Ingest as a knowledge page via `wiki-ingest` (for ideas with sources)
   135|   135|- Leave in place (for notes that don't need action yet)
   136|   136|
