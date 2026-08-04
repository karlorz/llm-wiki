# Agent Memory Research Gap Closure — Design

**Date:** 2026-08-04
**Status:** Approved (section-by-section)
**Approach:** A — Minimal-change, additive-only

## Context

The 2026-08-04 attended `$daily-wiki-sleep deep` cycle identified 6 gaps in the
agent-memory research pipeline. Three scouts explored the vault architecture
pages, the `packages/agent-memory-trends/` source, and the research output
(daily digests, evidence files, task captures). The July 19 idea-distillation
page provided pre-synthesized adopt/adapt/reject conclusions for the 3 open
evaluate tasks.

The gaps span three work types: source-code changes to the
`packages/agent-memory-trends` package, vault work items (decisions and
investigations), and process/documentation changes.

## Constraints

- **Fleet-dependent:** The agent-memory-trends package runs on sg02 as a
  nightly systemd service. Other hosts (sg01 snapshotter, macos-dev) depend on
  its output. Changes must be backward-compatible with running sg02
  infrastructure.
- **Plane B parked:** No Plane B design, research, planning, or implementation.
- **No llm-wiki source edits** from the daily-wiki-sleep personal V1 skill.
- **No direct root projection edits** to root `index.md` or `log.md`.
- **SCHEMA.md is in bounds** — it is the vault schema, not a root projection.

## Work Item Structure

A single umbrella work item `2026-08-04-agent-memory-research-gap-closure` ties
all 6 gaps together. It has 5 child work items, each in its own directory under
`projects/llm-wiki/work/`.

## Design Sections

### 1. Post-render file-existence check in publish gate

**Gap:** The 2026-08-01 run manifest declared a task capture path
(`raw/transcripts/2026-08-01-task-evaluate-awesome-agent-skills-*.md`) but the
file did not exist on disk. The publish gate did not catch this because it
validates manifest declarations but not file existence.

**Change:** Add a file-existence verification to `validateGeneratedChanges` in
`packages/agent-memory-trends/src/allowlist.ts`. After the existing check that
`taskCapturePaths` are declared and marked as TypeScript-rendered (lines
110-113), verify each path exists on disk via `existsSync`. If any declared
capture path is missing, push a `partial render failure` issue into the issues
array, causing the publish to fail with `ALLOWLIST_REJECTED`.

**Code location:** `packages/agent-memory-trends/src/allowlist.ts`, in
`validateGeneratedChanges`, after the `taskCaptureRenderer !== "typescript"`
check (line 113). The `existsSync` and `join` imports are already present at
line 1.

```typescript
for (const path of taskCaptures) {
  if (!existsSync(join(input.vault, path))) {
    issues.push(`task capture path ${path} declared in manifest but not found on disk (partial render failure)`);
  }
}
```

**Testing:** Add a test case to `packages/agent-memory-trends/test/allowlist.test.ts`
that creates a manifest with `taskCapturePaths` pointing to a non-existent file
and asserts the validation rejects with `ALLOWLIST_REJECTED` containing
`partial render failure`.

**Backward compat:** Additive check only. Existing runs with valid renders are
unaffected. Runs with missing renders now fail closed instead of publishing a
bad manifest.

### 2. Close 3 open evaluate tasks as decision pages

**Gap:** Three task captures from the agent-memory-trends pipeline remain
unclaimed. They were identified in the July 19 idea distillation with clear
adopt/adapt/reject conclusions but never closed.

**Decisions (pre-decided from July 19 distillation):**

1. **deer-flow → adapt.** Work item:
   `2026-08-04-evaluate-deer-flow-harness-contract-patterns`. Borrow explicit
   harness contracts (what may mutate memory, what is sandboxed, what is
   skill-only) as a concept note. Do not adopt DeerFlow wholesale. Evidence:
   July 19 distillation #1 ranked idea; task capture at
   `raw/transcripts/2026-07-07-task-evaluate-deer-flow-sub-agent-memory-and-sandbox-harness-patterns-for-llm-wiki.md`.

2. **notebooklm-py → adapt.** Work item:
   `2026-08-04-evaluate-notebooklm-master-brain-session-continuity`. Adopt the
   "Master Brain" metaphor as a conceptual mapping to the existing
   session-brief + compound/log + pinned context surface. Reject NotebookLM as
   SSOT. Evidence: July 19 distillation #2 ranked idea; task capture at
   `raw/transcripts/2026-07-06-task-evaluate-notebooklm-py-notebooklm-skill-and-master-brain-session-continuity-for.md`.

3. **iai-personal-memory-engine → reject.** Work item:
   `2026-08-04-evaluate-iai-mcp-personal-memory`. Reject as implementation
   direction because MCP product spend remains shelved (per
   `raw/transcripts/2026-07-02-decision-mcp-shelved.md`). Useful as compare-only
   contrast for `comparisons/agent-memory-architectures.md`. Evidence: July 19
   distillation #3 ranked idea; task capture at
   `raw/transcripts/2026-07-03-task-evaluate-iai-personal-memory-engine-mcp-memory-for-llm-wiki.md`.

**Format:** Each work item follows the existing `spec.md` + `decision.md`
pattern (like the completed `2026-07-28-agency-agents-evaluation`). Each
`decision.md` contains the disposition, rationale, and source anchors. Each
`spec.md` sets `status: completed`, `kind: decision`, `automation_ready: false`.

**Vault impact:** 3 new work-item directories under
`projects/llm-wiki/work/2026-08-04-*`, each with `spec.md` and `decision.md`.

### 3. Query-ranking regression work item

**Gap:** The deep-cycle query-ranking probe confirmed that operational queries
("project index", "memory review", "daily wiki sleep") return historical
research-cycle pages instead of operational pages. The 2026-07-15
authority-first ordering fix corrected memory topic ordering but not the
general query ranking.

**Change:** Create a new work item
`2026-08-04-query-ranking-regression-investigation` with a `spec.md` that
documents the regression, the 3 probe queries, expected vs actual results, and
proposes an investigation into the skillwiki query ranking internals.

**Scope:** Vault-only. The spec sets `status: pending`, `kind: investigation`,
`priority: medium`, `automation_ready: false`. No source changes.

**Vault impact:** 1 new work-item directory with `spec.md` only.

### 4. Digest coverage gap investigation note

**Gap:** No digests were published between July 10 and July 21 (11-day gap)
despite the nightly timer running. Unverified whether runs were skipped,
synthesis was quiet (no candidates), or digests were generated but not
committed.

**Change:** Create a work item
`2026-08-04-digest-coverage-gap-investigation` with a `spec.md` that documents
the gap, lists the missing dates, and proposes a verification step: check
`.skillwiki/agent-memory-trends/` run files for each missing date to determine
whether runs occurred.

**Scope:** Read-only investigation. The spec sets `status: pending`, `kind:
investigation`, `priority: low`, `automation_ready: false`. No source changes.

**Vault impact:** 1 new work-item directory with `spec.md` only.

### 5. Process changes

#### 5a: Periodic research-distillation pass

Document a quarterly attended research-distillation step in
`packages/agent-memory-trends/README.md` as a new "Periodic Review" subsection.
This is not a new automation, CLI subcommand, or scheduled job. It is operator
guidance: when running a `$daily-wiki-sleep deep` cycle at quarter boundaries
(roughly every 90 days), review the latest 10 agent-memory-trends digests,
distill transferable ideas, and record findings as a query page following the
July 19 idea-distillation page as the template. The step is optional and does
not block the deep cycle.

#### 5b: Watchlist auto-append threshold adjustment

Change `auto_append.min_appearances` in
`projects/llm-wiki/architecture/agent-memory-research-sources.yaml` from `3` to
`2`. No repo has hit the threshold of 3-in-14-days since the watchlist was
created. Lowering to 2 would auto-capture repos that appear in consecutive runs,
reducing manual curation burden. The threshold is config-driven (validated at
`config.ts` with `min_appearances >= 1`), so no code changes are needed. The
change takes effect on the next nightly run.

**Vault impact:** 2 files modified —
`packages/agent-memory-trends/README.md` (add Periodic Review subsection) and
`projects/llm-wiki/architecture/agent-memory-research-sources.yaml` (threshold
change).

### 6. Umbrella work item

A single umbrella work item `2026-08-04-agent-memory-research-gap-closure` ties
all 6 gaps together with a `spec.md` and `decision.md`.

**Spec.md:** `kind: feature`, `status: in_progress`, `priority: medium`,
`automation_ready: false`. Lists all 6 sub-items with their dispositions and
locations.

**Decision.md:** Documents the approach chosen (Approach A: minimal-change,
additive-only) and the 8 dispositions.

## Artifact Summary

| # | Gap | Type | Artifact | Status |
|---|-----|------|----------|--------|
| 1 | Partial-failure detection | Source code | `allowlist.ts` + `allowlist.test.ts` | New check |
| 2 | deer-flow evaluate | Vault work item | `2026-08-04-evaluate-deer-flow-*` | Completed decision: adapt |
| 3 | notebooklm-py evaluate | Vault work item | `2026-08-04-evaluate-notebooklm-*` | Completed decision: adapt |
| 4 | iai evaluate | Vault work item | `2026-08-04-evaluate-iai-*` | Completed decision: reject |
| 5 | Query-ranking regression | Vault work item | `2026-08-04-query-ranking-*` | Pending investigation |
| 6 | Digest coverage gap | Vault work item | `2026-08-04-digest-coverage-*` | Pending investigation |
| 7 | Periodic analysis cadence | Process/doc | `README.md` Periodic Review | Documentation |
| 8 | Watchlist threshold | Vault config | `agent-memory-research-sources.yaml` | Config change |

## Non-goals

- Fixing inherited broken wikilinks (53 pre-existing) — deferred debt.
- Fixing the sensitive-content finding — existing, not introduced by this work.
- Fixing the query-ranking regression itself — this work item documents the
  finding and scopes the investigation; the fix is a separate implementation
  effort.
- Fixing the project-index staleness — requires a CLI feature gap fix.
- Editing root `index.md` or `log.md` directly.
- llm-wiki source edits from the daily-wiki-sleep skill.
- Plane B work (parked indefinitely).