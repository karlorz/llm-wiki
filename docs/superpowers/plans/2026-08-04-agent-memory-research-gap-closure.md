# Agent Memory Research Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 6 agent-memory research gaps: add a post-render file-existence check to the publish gate, close 3 open evaluate tasks as decision pages, document query-ranking regression and digest coverage gap as investigation work items, add a periodic-review section to the README, and lower the watchlist auto-append threshold.

**Architecture:** Approach A (minimal-change, additive-only). One umbrella work item ties all 6 gaps together. Source changes are additive to existing validation logic. Vault changes create new work-item directories following the existing spec/decision pattern. Process changes are documentation and config-only.

**Tech Stack:** TypeScript (packages/agent-memory-trends), Markdown/YAML (vault work items), vitest (testing).

## Global Constraints

- Fleet-dependent: changes must be backward-compatible with running sg02 infrastructure.
- Plane B parked: no Plane B design, research, planning, or implementation.
- No direct root projection edits to root `index.md` or `log.md`.
- No daily-wiki-sleep skill source edits.
- SCHEMA.md is in bounds (vault schema, not root projection).
- Work items follow the existing `spec.md` + `decision.md` pattern.
- All vault work items go under `projects/llm-wiki/work/2026-08-04-*`.

---

## File Structure

### Source code changes (in `/Users/karlchow/Desktop/code/llm-wiki/`)
- `packages/agent-memory-trends/src/allowlist.ts` — add post-render file-existence check
- `packages/agent-memory-trends/test/allowlist.test.ts` — add test for the check
- `packages/agent-memory-trends/README.md` — add Periodic Review subsection

### Vault changes (in `/Users/karlchow/wiki/`)
- `projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/spec.md` — umbrella spec
- `projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/decision.md` — umbrella decision
- `projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/spec.md` — deer-flow decision spec
- `projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/decision.md` — deer-flow decision
- `projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/spec.md` — notebooklm-py decision spec
- `projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/decision.md` — notebooklm-py decision
- `projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/spec.md` — iai decision spec
- `projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/decision.md` — iai decision
- `projects/llm-wiki/work/2026-08-04-query-ranking-regression-investigation/spec.md` — query-ranking investigation spec
- `projects/llm-wiki/work/2026-08-04-digest-coverage-gap-investigation/spec.md` — digest coverage investigation spec
- `projects/llm-wiki/architecture/agent-memory-research-sources.yaml` — `min_appearances: 3` → `min_appearances: 2`

---

## Task 1: Post-render file-existence check in publish gate

**Files:**
- Modify: `packages/agent-memory-trends/src/allowlist.ts` (in `validateGeneratedChanges`, after line 113)
- Test: `packages/agent-memory-trends/test/allowlist.test.ts`

**Interfaces:**
- Consumes: `existsSync` (already imported at line 1), `join` (already imported at line 2), `input.vault`, `input.manifest.outputs.taskCapturePaths`
- Produces: additional `issues` entries that cause `ALLOWLIST_REJECTED` when task capture files are missing

- [ ] **Step 1: Write the failing test**

Add this test to `packages/agent-memory-trends/test/allowlist.test.ts`, after the last `it(...)` block inside the `describe(...)`:

```typescript
it("rejects a manifest whose task capture paths do not exist on disk (partial render failure)", () => {
  const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-allowlist-"));
  const missingCapturePath = "raw/transcripts/2026-06-11-task-missing-render.md";
  const runManifest = manifest({
    changedFiles: [
      "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      "queries/2026-06-11-agent-memory-trends-digest.md",
      missingCapturePath,
      "meta/latest-session-brief.md",
      ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
    ],
    outputs: {
      evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
      taskCapturePaths: [missingCapturePath],
      taskCaptureRenderer: "typescript",
      sessionBriefPath: "meta/latest-session-brief.md",
      runStatePath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      latestRunPath: ".skillwiki/agent-memory-trends/latest-run.json",
    },
  });
  // Write all changed files EXCEPT the missing capture path
  for (const path of runManifest.changedFiles) {
    if (path !== missingCapturePath) writeVaultFile(vault, path, `generated file ${path}\n`);
  }

  const result = validateGeneratedChanges({
    vault,
    runDate: "2026-06-11",
    changedFiles: runManifest.changedFiles,
    manifest: runManifest,
    existingRawPaths: [],
    maxFileBytes: 128 * 1024,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe("ALLOWLIST_REJECTED");
    expect(result.detail).toContain("partial render failure");
    expect(result.detail).toContain(missingCapturePath);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run -w @skillwiki/agent-memory-trends test -- --run 2>&1 | grep "partial render failure" || echo "TEST NOT YET FAILING - expected until implementation"`
Expected: The new test appears in output but the assertion fails because the file-existence check does not exist yet. The manifest validation currently passes because it only checks declarations, not disk existence.

- [ ] **Step 3: Write minimal implementation**

In `packages/agent-memory-trends/src/allowlist.ts`, inside `validateGeneratedChanges`, after the block at lines 112-114 (`if (taskCaptures.length > 0 && input.manifest.outputs.taskCaptureRenderer !== "typescript")`), add:

```typescript
  for (const path of taskCaptures) {
    if (!existsSync(join(input.vault, path))) {
      issues.push(`task capture path ${path} declared in manifest but not found on disk (partial render failure)`);
    }
  }
```

The `existsSync` and `join` imports are already present at line 1: `import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";` and line 2: `import { join } from "node:path";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run -w @skillwiki/agent-memory-trends test -- --run 2>&1 | tail -20`
Expected: All tests pass, including the new "rejects a manifest whose task capture paths do not exist on disk" test.

- [ ] **Step 5: Run typecheck**

Run: `npm run -w @skillwiki/agent-memory-trends typecheck 2>&1 | tail -5`
Expected: No type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-memory-trends/src/allowlist.ts packages/agent-memory-trends/test/allowlist.test.ts
git commit -m "feat(agent-memory-trends): add post-render file-existence check to publish gate

Reject manifests with declared taskCapturePaths that do not exist on disk.
Prevents partial render failures (like 2026-08-01) from publishing bad manifests."
```

---

## Task 2: Close deer-flow evaluate task as adapt decision

**Files:**
- Create: `projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/spec.md`
- Create: `projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/decision.md`

**Interfaces:**
- Consumes: July 19 distillation findings from `queries/2026-07-19-agent-memory-trends-idea-distillation.md`, task capture at `raw/transcripts/2026-07-07-task-evaluate-deer-flow-sub-agent-memory-and-sandbox-harness-patterns-for-llm-wiki.md`, June 19 ADR at `projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md`
- Produces: Completed decision work item with `adapt` disposition

- [ ] **Step 1: Create spec.md**

Create `projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/spec.md`:

```markdown
---
title: "Evaluate deer-flow harness contract patterns for llm-wiki"
name: evaluate-deer-flow-harness-contract-patterns
description: "Pre-decided adaptation of explicit harness contracts (what may mutate memory, what is sandboxed, what is skill-only) from deer-flow patterns, without wholesale adoption."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "raw/transcripts/2026-07-07-task-evaluate-deer-flow-sub-agent-memory-and-sandbox-harness-patterns-for-llm-wiki.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
tags:
  - agent-memory
  - research
  - harness
  - deer-flow
---

# Evaluate deer-flow harness contract patterns for llm-wiki

## Problem

The `bytedance/deer-flow` repository was selected by the agent-memory-trends
pipeline on 2026-07-07 as a high-signal candidate (score 98) for its
sub-agent + memory + sandbox + skills harness composition patterns. A task
capture was created but never closed with an adopt/adapt/reject decision.

## Decision

**Adapt.** Borrow the explicit harness contract concept — clearly separating
what may mutate memory, what is sandboxed, and what is skill-only — as a
concept note. Do not adopt DeerFlow wholesale.

## Rationale

The July 19 idea distillation ranked this as the #1 transferable idea: "Long-
horizon agent = sub-agents + durable memory + sandboxes + skills as one
harness." The pieces already exist in llm-wiki (skills, work items, vault
memory, satellite jobs). The value is in making the harness contracts
explicit, not in importing deer-flow's implementation.

The June 19 ADR already separates Plane A (deterministic vault + CLI) from
Plane B (optional runtime). Deer-flow's harness contract concept reinforces
this boundary rather than crossing it.

## Non-goals

- No deer-flow code, configuration, or dependency import.
- No new harness implementation — this is a conceptual adaptation only.
- No Plane B activation.
```

- [ ] **Step 2: Create decision.md**

Create `projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/decision.md`:

```markdown
---
title: "Decision — deer-flow harness contract patterns for llm-wiki"
name: evaluate-deer-flow-harness-contract-patterns-decision
description: "Adopt the explicit harness contract concept from deer-flow as a concept note, without wholesale adoption."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/spec.md"
  - "raw/transcripts/2026-07-07-task-evaluate-deer-flow-sub-agent-memory-and-sandbox-harness-patterns-for-llm-wiki.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
tags:
  - agent-memory
  - research
  - harness
  - deer-flow
---

# Decision — deer-flow harness contract patterns for llm-wiki

## Decision

**Adapt.** Borrow the explicit harness contract concept — what may mutate
memory, what is sandboxed, what is skill-only — as a conceptual pattern. Do
not adopt deer-flow code, configuration, or dependencies.

## Evidence

- July 19 idea distillation ranked this #1: "Long-horizon agent = sub-agents
  + durable memory + sandboxes + skills as one harness."
- The task capture at
  `raw/transcripts/2026-07-07-task-evaluate-deer-flow-sub-agent-memory-and-sandbox-harness-patterns-for-llm-wiki.md`
  identified the harness composition as the transferable idea.
- The June 19 ADR already separates Plane A (deterministic vault + CLI) from
  Plane B (optional runtime). Deer-flow's contract concept reinforces this
  boundary.

## What this does not authorize

- No deer-flow code, configuration, or dependency import.
- No new harness implementation — this is a conceptual adaptation only.
- No Plane B activation.

## Status

Closed. The conceptual adaptation is recorded; no further action needed
unless a separate work item proposes concrete harness contract documentation.
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/spec.md \
  projects/llm-wiki/work/2026-08-04-evaluate-deer-flow-harness-contract-patterns/decision.md
git -C /Users/karlchow/wiki commit -m "work(deer-flow): close evaluate task as adapt — harness contract concept"
```

---

## Task 3: Close notebooklm-py evaluate task as adapt decision

**Files:**
- Create: `projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/spec.md`
- Create: `projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/decision.md`

**Interfaces:**
- Consumes: July 19 distillation, task capture at `raw/transcripts/2026-07-06-task-evaluate-notebooklm-py-notebooklm-skill-and-master-brain-session-continuity-for.md`
- Produces: Completed decision work item with `adapt` disposition

- [ ] **Step 1: Create spec.md**

Create `projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/spec.md`:

```markdown
---
title: "Evaluate notebooklm-py Master Brain session continuity for llm-wiki"
name: evaluate-notebooklm-master-brain-session-continuity
description: "Pre-decided adaptation of the Master Brain metaphor (append decisions, reload at start) as a mapping to session-brief + compound/log, without adopting NotebookLM as SSOT."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "raw/transcripts/2026-07-06-task-evaluate-notebooklm-py-notebooklm-skill-and-master-brain-session-continuity-for.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
tags:
  - agent-memory
  - research
  - session-brief
  - notebooklm
---

# Evaluate notebooklm-py Master Brain session continuity for llm-wiki

## Problem

The `teng-lin/notebooklm-py` repository was selected by the agent-memory-trends
pipeline on 2026-07-06 as a high-signal candidate (score 97) for its Master
Brain session continuity pattern (append decisions, reload at next start) and
optional zero-token research offload. A task capture was created but never
closed.

## Decision

**Adapt.** Adopt the "Master Brain" metaphor as a conceptual mapping to the
existing session-brief + compound/log + pinned context surface. Reject
NotebookLM as SSOT.

## Rationale

The July 19 idea distillation ranked this as the #2 transferable idea, noting
it "maps nearly 1:1 to session-brief + compound/log + pinned context." The
existing session-brief surface already implements the append-decisions-
and-reload pattern. The value is in the product metaphor, not the
implementation.

## Non-goals

- No NotebookLM adoption as vault SSOT.
- No new session-brief implementation — the existing surface is sufficient.
- No Plane B activation.
```

- [ ] **Step 2: Create decision.md**

Create `projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/decision.md`:

```markdown
---
title: "Decision — notebooklm-py Master Brain session continuity for llm-wiki"
name: evaluate-notebooklm-master-brain-session-continuity-decision
description: "Adopt the Master Brain metaphor as a conceptual mapping to session-brief, without adopting NotebookLM as SSOT."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/spec.md"
  - "raw/transcripts/2026-07-06-task-evaluate-notebooklm-py-notebooklm-skill-and-master-brain-session-continuity-for.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
tags:
  - agent-memory
  - research
  - session-brief
  - notebooklm
---

# Decision — notebooklm-py Master Brain session continuity for llm-wiki

## Decision

**Adapt.** Adopt the "Master Brain" metaphor — append session decisions,
reload at next start — as a conceptual mapping to the existing session-brief +
compound/log + pinned context surface. Reject NotebookLM as vault SSOT.

## Evidence

- July 19 idea distillation ranked this #2: "Maps nearly 1:1 to session-brief
  + compound/log + pinned context. Strong product metaphor; reject NotebookLM
  as SSOT."
- The task capture at
  `raw/transcripts/2026-07-06-task-evaluate-notebooklm-py-notebooklm-skill-and-master-brain-session-continuity-for.md`
  identified the Master Brain pattern as the transferable idea.
- The existing session-brief surface already implements the append-and-reload
  pattern.

## What this does not authorize

- No NotebookLM adoption as vault SSOT.
- No new session-brief implementation.
- No Plane B activation.

## Status

Closed. The conceptual adaptation is recorded; no further action needed.
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/spec.md \
  projects/llm-wiki/work/2026-08-04-evaluate-notebooklm-master-brain-session-continuity/decision.md
git -C /Users/karlchow/wiki commit -m "work(notebooklm-py): close evaluate task as adapt — Master Brain metaphor"
```

---

## Task 4: Close iai evaluate task as reject decision

**Files:**
- Create: `projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/spec.md`
- Create: `projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/decision.md`

**Interfaces:**
- Consumes: July 19 distillation, task capture at `raw/transcripts/2026-07-03-task-evaluate-iai-personal-memory-engine-mcp-memory-for-llm-wiki.md`, MCP shelve decision at `raw/transcripts/2026-07-02-decision-mcp-shelved.md`
- Produces: Completed decision work item with `reject` disposition

- [ ] **Step 1: Create spec.md**

Create `projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/spec.md`:

```markdown
---
title: "Evaluate iai personal memory engine MCP for llm-wiki"
name: evaluate-iai-mcp-personal-memory
description: "Pre-decided rejection of iai MCP personal memory engine as implementation direction; MCP product spend remains shelved. Useful as compare-only contrast."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "raw/transcripts/2026-07-03-task-evaluate-iai-personal-memory-engine-mcp-memory-for-llm-wiki.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "raw/transcripts/2026-07-02-decision-mcp-shelved.md"
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
tags:
  - agent-memory
  - research
  - mcp
  - iai
---

# Evaluate iai personal memory engine MCP for llm-wiki

## Problem

The `CodeAbra/iai-personal-memory-engine` repository was selected by the
agent-memory-trends pipeline on 2026-07-03 for its MCP personal memory with
verbatim recall, encryption, and hybrid retrieval. A task capture was created
but never closed.

## Decision

**Reject** as an implementation direction. MCP product spend remains shelved
per `raw/transcripts/2026-07-02-decision-mcp-shelved.md`. The iai engine is
useful as a compare-only contrast for
`comparisons/agent-memory-architectures.md`.

## Rationale

The July 19 idea distillation ranked this #3, noting: "Keep file vault as
authority; optional index/search only if reconstructible from Markdown.
Reinforces the agent-memory ADR (layer over vault, not replacement). Product
MCP spend remains shelved."

The June 19 ADR explicitly rejects MCP write services as canonical knowledge.
The MCP shelve decision (2026-07-02) parks MCP product work until a remote
centralized wiki requires it. This evaluation confirms that decision.

## Non-goals

- No iai code, MCP integration, or dependency import.
- No MCP unshelving — requires a separate product decision.
- No Plane B activation.
```

- [ ] **Step 2: Create decision.md**

Create `projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/decision.md`:

```markdown
---
title: "Decision — iai personal memory engine MCP for llm-wiki"
name: evaluate-iai-mcp-personal-memory-decision
description: "Reject iai MCP personal memory engine as implementation direction; MCP shelved. Useful as compare-only contrast."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/spec.md"
  - "raw/transcripts/2026-07-03-task-evaluate-iai-personal-memory-engine-mcp-memory-for-llm-wiki.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "raw/transcripts/2026-07-02-decision-mcp-shelved.md"
tags:
  - agent-memory
  - research
  - mcp
  - iai
---

# Decision — iai personal memory engine MCP for llm-wiki

## Decision

**Reject** as an implementation direction. MCP product spend remains shelved.

## Evidence

- July 19 idea distillation: "Keep file vault as authority; optional
  index/search only if reconstructible from Markdown. Product MCP spend
  remains shelved."
- The MCP shelve decision
  (`raw/transcripts/2026-07-02-decision-mcp-shelved.md`) parks MCP product
  work until a remote centralized wiki requires it.
- The June 19 ADR explicitly rejects MCP write services as canonical
  knowledge.

## Compare-only value

The iai engine remains useful as a compare-only contrast for
`comparisons/agent-memory-architectures.md`. It demonstrates the
encryption + hybrid retrieval approach that the vault-first architecture
deliberately avoids.

## What this does not authorize

- No iai code, MCP integration, or dependency import.
- No MCP unshelving — requires a separate product decision.
- No Plane B activation.

## Status

Closed. The rejection is recorded; no further action needed.
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/spec.md \
  projects/llm-wiki/work/2026-08-04-evaluate-iai-mcp-personal-memory/decision.md
git -C /Users/karlchow/wiki commit -m "work(iai): close evaluate task as reject — MCP shelved"
```

---

## Task 5: Create query-ranking regression investigation work item

**Files:**
- Create: `projects/llm-wiki/work/2026-08-04-query-ranking-regression-investigation/spec.md`

**Interfaces:**
- Consumes: deep-cycle probe results, 2026-07-15 authority-first ordering fix
- Produces: Pending investigation work item documenting the regression

- [ ] **Step 1: Create spec.md**

Create `projects/llm-wiki/work/2026-08-04-query-ranking-regression-investigation/spec.md`:

```markdown
---
title: "Query-ranking regression investigation"
name: query-ranking-regression-investigation
description: "Document and investigate the query-ranking regression where operational queries return historical research-cycle pages instead of operational pages."
kind: investigation
status: pending
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: false
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
  - "comparisons/agent-memory-architectures.md"
  - "projects/llm-wiki/work/2026-07-15-authority-first-memory-ordering/spec.md"
tags:
  - query-ranking
  - regression
  - skillwiki
---

# Query-ranking regression investigation

## Problem

The 2026-08-04 deep-cycle query-ranking probe confirmed that operational
queries return historical research-cycle pages instead of operational pages.

### Probe results

| Query | Expected | Actual (top 3) |
|-------|----------|----------------|
| "project index" | Project index pages, architecture docs | `research-cycle-159-report.md` (3687.2), `research-cycle-162-report.md` (3687.2), `research-cycle-169-report.md` (3676.2) |
| "memory review" | Memory review spec, ADR | `knowledge-monetization-strategy.md` (3906.3), `research-cycle-159-report.md` (3676.2), `research-cycle-162-report.md` (3676.2) |
| "daily wiki sleep" | Daily-wiki-sleep skill, runbook | `knowledge-monetization-strategy.md` (3682.3), `research-cycle-159-report.md` (3435.3), `research-cycle-162-report.md` (3435.3) |

### Context

The 2026-07-15 authority-first ordering fix corrected memory topic ordering
so accepted/active decisions rank before exploratory material. However, the
general query ranking was not adjusted. The query path uses a 4-signal scorer
(source overlap 4.0x, wikilink 3.0x, Adamic-Adar 1.5x, type 1.0x). Historical
research-cycle pages accumulate high source-overlap and wikilink scores,
drowning out operational pages with fewer but more relevant connections.

## Scope

This work item documents the finding and scopes the investigation. The fix
requires understanding the skillwiki query ranking internals, which is a
separate implementation effort.

## Proposed investigation steps

1. Inspect the skillwiki query scoring implementation.
2. Evaluate whether a type-weight adjustment or a recency-authority signal
   could be added without breaking existing query behavior.
3. Prototype the fix and run the 3 probe queries to verify operational pages
   rank above historical research pages.

## Non-goals

- This spec does not propose a fix — only the investigation.
- No source changes in this work item.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/work/2026-08-04-query-ranking-regression-investigation/spec.md
git -C /Users/karlchow/wiki commit -m "work(query-ranking): document regression as pending investigation"
```

---

## Task 6: Create digest coverage gap investigation work item

**Files:**
- Create: `projects/llm-wiki/work/2026-08-04-digest-coverage-gap-investigation/spec.md`

**Interfaces:**
- Consumes: digest publication dates from `queries/*-agent-memory-trends-digest.md`
- Produces: Pending investigation work item documenting the coverage gap

- [ ] **Step 1: Create spec.md**

Create `projects/llm-wiki/work/2026-08-04-digest-coverage-gap-investigation/spec.md`:

```markdown
---
title: "Digest coverage gap investigation (2026-07-11 to 2026-07-20)"
name: digest-coverage-gap-investigation
description: "Investigate the 11-day gap in agent-memory-trends digest publication between July 10 and July 21."
kind: investigation
status: pending
priority: low
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: false
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "queries/2026-07-10-agent-memory-trends-digest.md"
  - "queries/2026-07-21-agent-memory-trends-digest.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
tags:
  - agent-memory
  - trends
  - coverage-gap
---

# Digest coverage gap investigation (2026-07-11 to 2026-07-20)

## Problem

No agent-memory-trends digests were published between July 10 and July 21
(11-day gap) despite the nightly systemd timer running on sg02.

### Missing dates

July 11, 12, 13, 14, 15, 16, 17, 18, 19, 20

### Context

The July 19 idea distillation records the gap as a "quiet streak" (July 11-19)
with `status: success`, `selected_candidate_count: 0`, `heartbeat:
generate-only`. The last digest before the gap is July 10; the next after is
July 21.

Evidence files may exist for some days without digests — unverified whether
runs were skipped, synthesis was quiet (no candidates), or digests were
generated but not committed.

## Scope

Read-only investigation. No fixes proposed — just documentation and
verification.

## Proposed verification step

Check `.skillwiki/agent-memory-trends/` run files for each missing date to
determine whether runs occurred. If runs occurred with 0 selected candidates,
the gap is explained as quiet runs. If runs are missing, investigate the
timer/service logs.

## Non-goals

- No source changes.
- No fix — this is documentation only.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/work/2026-08-04-digest-coverage-gap-investigation/spec.md
git -C /Users/karlchow/wiki commit -m "work(digest-coverage): document 11-day digest coverage gap as pending investigation"
```

---

## Task 7: Add periodic review section to README and adjust watchlist threshold

**Files:**
- Modify: `packages/agent-memory-trends/README.md` (add Periodic Review subsection after line 330)
- Modify: `projects/llm-wiki/architecture/agent-memory-research-sources.yaml` (line 124: `min_appearances: 3` → `min_appearances: 2`)

**Interfaces:**
- Consumes: existing README structure, existing YAML config
- Produces: operator guidance for quarterly review, lower auto-append threshold

- [ ] **Step 1: Add Periodic Review section to README**

In `packages/agent-memory-trends/README.md`, after the last line of the Safety Contract section (line 330, `- \`sg01\` is read-only for this workflow.`), add:

```markdown

## Periodic Review

The nightly pipeline collects and synthesizes GitHub candidates automatically.
A quarterly attended research-distillation pass complements the automation:

- When running a `$daily-wiki-sleep deep` cycle at quarter boundaries (roughly
  every 90 days), review the latest 10 agent-memory-trends digests.
- Distill transferable ideas and record findings as a query page.
- Follow the July 19 idea-distillation page
  (`queries/2026-07-19-agent-memory-trends-idea-distillation.md`) as the
  template.
- This step is optional and does not block the deep cycle.
```

- [ ] **Step 2: Adjust watchlist threshold**

In `projects/llm-wiki/architecture/agent-memory-research-sources.yaml`, change line 124:

From:
```yaml
    min_appearances: 3
```

To:
```yaml
    min_appearances: 2
```

- [ ] **Step 3: Commit source README change**

```bash
git add packages/agent-memory-trends/README.md
git commit -m "docs(agent-memory-trends): add Periodic Review section for quarterly distillation"
```

- [ ] **Step 4: Commit vault config change**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/architecture/agent-memory-research-sources.yaml
git -C /Users/karlchow/wiki commit -m "config(agent-memory-trends): lower watchlist auto-append threshold from 3 to 2"
```

---

## Task 8: Create umbrella work item

**Files:**
- Create: `projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/spec.md`
- Create: `projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/decision.md`

**Interfaces:**
- Consumes: all 5 child work items, the design doc, the deep-cycle report
- Produces: Umbrella work item tying all 6 gaps together

- [ ] **Step 1: Create spec.md**

Create `projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/spec.md`:

```markdown
---
title: "Agent memory research gap closure"
name: agent-memory-research-gap-closure
description: "Close 6 agent-memory research gaps identified in the 2026-08-04 deep-cycle analysis: pipeline partial-failure detection, 3 open evaluate tasks, query-ranking regression, digest coverage gap, periodic research analysis cadence, watchlist threshold tuning."
kind: feature
status: in_progress
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "docs/superpowers/specs/2026-08-04-agent-memory-research-gap-closure-design.md"
  - "queries/2026-07-19-agent-memory-trends-idea-distillation.md"
  - "projects/llm-wiki/architecture/2026-06-19-agent-memory-architecture.md"
  - "queries/2026-08-03-agent-memory-trends-digest.md"
tags:
  - agent-memory
  - research
  - gap-closure
---

# Agent memory research gap closure

## Problem

The 2026-08-04 attended `$daily-wiki-sleep deep` cycle identified 6 gaps in
the agent-memory research pipeline. This umbrella work item ties all 6 gaps
together.

## Sub-items

| # | Gap | Disposition | Child work item | Status |
|---|-----|-------------|-----------------|--------|
| 1 | Partial-failure detection | Fix | `packages/agent-memory-trends/src/allowlist.ts` + test | Source change |
| 2 | deer-flow evaluate | Adapt | `2026-08-04-evaluate-deer-flow-harness-contract-patterns` | Completed |
| 3 | notebooklm-py evaluate | Adapt | `2026-08-04-evaluate-notebooklm-master-brain-session-continuity` | Completed |
| 4 | iai evaluate | Reject | `2026-08-04-evaluate-iai-mcp-personal-memory` | Completed |
| 5 | Query-ranking regression | Investigate | `2026-08-04-query-ranking-regression-investigation` | Pending |
| 6 | Digest coverage gap | Investigate | `2026-08-04-digest-coverage-gap-investigation` | Pending |
| 7 | Periodic analysis cadence | Document | `packages/agent-memory-trends/README.md` Periodic Review | Documentation |
| 8 | Watchlist threshold | Tune | `agent-memory-research-sources.yaml` | Config change |

## Approach

Approach A: minimal-change, additive-only. Source changes are additive to
existing validation logic. Vault changes create new work-item directories
following the existing spec/decision pattern. Process changes are
documentation and config-only.

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
```

- [ ] **Step 2: Create decision.md**

Create `projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/decision.md`:

```markdown
---
title: "Decision — agent memory research gap closure approach"
name: agent-memory-research-gap-closure-decision
description: "Approach A (minimal-change, additive-only) chosen for closing 6 agent-memory research gaps."
kind: decision
status: completed
priority: medium
project: "[[llm-wiki]]"
created: 2026-08-04
started: 2026-08-04
completed: 2026-08-04
updated: 2026-08-04
automation_ready: false
human_questions_resolved: true
provenance: project
provenance_projects:
  - "[[llm-wiki]]"
sources:
  - "projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/spec.md"
  - "docs/superpowers/specs/2026-08-04-agent-memory-research-gap-closure-design.md"
tags:
  - agent-memory
  - research
  - gap-closure
---

# Decision — agent memory research gap closure approach

## Decision

Approach A: minimal-change, additive-only.

## Dispositions

| # | Gap | Disposition |
|---|-----|-------------|
| 1 | Partial-failure detection | Fix (additive check in publish gate) |
| 2 | deer-flow evaluate | Adapt (harness contract concept) |
| 3 | notebooklm-py evaluate | Adapt (Master Brain metaphor) |
| 4 | iai evaluate | Reject (MCP shelved) |
| 5 | Query-ranking regression | Investigate (document finding, scope fix) |
| 6 | Digest coverage gap | Investigate (document gap, verify run files) |
| 7 | Periodic analysis cadence | Document (README quarterly review) |
| 8 | Watchlist threshold | Tune (3 → 2 in config YAML) |

## Rationale

The 6 gaps are existing debt, not new infrastructure needs. The minimal-change
approach keeps backward compatibility with running sg02 infrastructure. The
post-render file-existence check is the highest-value source change. The 3
decision pages clear the oldest research backlog. The process documentation
is lightweight. The query-ranking regression deserves its own work item
because it targets a different subsystem.

## Status

Completed. All 8 dispositions recorded. Child work items created.
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/karlchow/wiki add \
  projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/spec.md \
  projects/llm-wiki/work/2026-08-04-agent-memory-research-gap-closure/decision.md
git -C /Users/karlchow/wiki commit -m "work(gap-closure): create umbrella work item for 6 agent-memory research gaps"
```

---

## Task 9: Run tests and verify

**Files:**
- Verify: `packages/agent-memory-trends/src/allowlist.ts`
- Verify: `packages/agent-memory-trends/test/allowlist.test.ts`

- [ ] **Step 1: Run full test suite**

Run: `npm run -w @skillwiki/agent-memory-trends test -- --run 2>&1 | tail -30`
Expected: All tests pass, including the new "rejects a manifest whose task capture paths do not exist on disk" test.

- [ ] **Step 2: Run typecheck**

Run: `npm run -w @skillwiki/agent-memory-trends typecheck 2>&1 | tail -5`
Expected: No type errors.

- [ ] **Step 3: Run build**

Run: `npm run -w @skillwiki/agent-memory-trends build 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 4: Verify vault git state**

Run: `git -C /Users/karlchow/wiki log --oneline -10`
Expected: Commits for each child work item, the umbrella work item, and the config change.

Run: `git -C /Users/karlchow/wiki diff --stat`
Expected: Only `agent-memory-research-sources.yaml` modified (the threshold change). All work items should already be committed.

- [ ] **Step 5: Verify source git state**

Run: `git -C /Users/karlchow/Desktop/code/llm-wiki log --oneline -5`
Expected: Commits for allowlist.ts + test, README, and the design doc.