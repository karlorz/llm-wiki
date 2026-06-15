---
name: wiki-query
description: Search the vault and synthesize an answer with E2 4-signal ranking. Optional file to queries/ or comparisons/.
---
# wiki-query
## When This Skill Activates
- User asks a question that should be answered from vault contents.
- A vault is resolvable (see step 0).
## Output language
Run `skillwiki lang` at the start. Generate query-result prose and `--human` summaries in the resolved language. Frontmatter keys, file names, schema headers, index/log structural lines, citation markers, and wikilink slugs MUST stay English.
## Pre-orientation reads
Standard four reads (SCHEMA, index, log, project context if applicable).
## Steps
0. **Resolve vault and language.** Run `skillwiki path` (fail if NO_VAULT_CONFIGURED) and `skillwiki lang`.
1. **Determine scope.** Ask the user once if ambiguous: vault | current project | project+concepts.
2. **Refresh graph.** If `.skillwiki/graph.json` is missing or older than 24h: `skillwiki graph build <vault>`.
3. **Compute overlap.** `skillwiki overlap <vault>`.
4. **Score candidates** in prompt using the 4 signals:
- Direct wikilink: 3.0×
- Source overlap: 4.0× (read from overlap output)
- Adamic-Adar: 1.5× (read from graph output)
- Type affinity: 1.0×
5. **Read top candidates** in full (frontmatter + body).
6. **Synthesize answer** with explicit citations to the candidate pages.
7. **Sensitive content guard.** Before filing any query or comparison page, scan the generated body for live credentials, access keys, tokens, passwords, cookies, bearer headers, or private keys. Redact before writing. If the answer depends on preserving a live secret, STOP and ask for a redacted source or explicit rotation/remediation direction.
8. **Optional file.** If user accepts: write to `queries/<slug>.md` or `comparisons/<slug>.md` with full frontmatter, validate, then update `index.md` then `log.md`. If the filed page is a research/evaluation answer, recommendation, or comparison, end it with:
```markdown
## Decision Closeout

Disposition: no-op | concept | ADR | work-item | evidence-needed
Reason: ...
Follow-up: ...
```
Use exactly one disposition. This is a prompt convention only; do not add CLI enforcement here.
## Stop conditions
- Zero matching pages.
- User declines to file.
- Generated filed content contains unredacted live credentials or other authenticating secrets.
## Pitfalls
### Claimed-status vs actual-state gap
When a wiki page (especially a work item `tasks.md`) claims that fixes were applied, features were completed, or files were removed — **verify on disk before accepting the claim**. In one incident, a `tasks.md` marked 6 items DONE but 5 were not actually applied: a script claimed "removed" was still 2020 bytes on disk, a crontab claimed "updated to 30min" was still `*/10`, and a build target claimed "verified has consumers" had no web server serving it.
**Rule**: After reading a work item that declares completion, run at least one verification command per critical claim (check file existence, grep a config, inspect a crontab). Documents can drift from reality — the filesystem is the source of truth.
## Forbidden
- Filing without `validate` passing.
- Skipping the orientation reads even for "quick" queries.
- Writing live credentials, access keys, tokens, passwords, cookies, bearer headers, private keys, or other authenticating secrets to the vault.
