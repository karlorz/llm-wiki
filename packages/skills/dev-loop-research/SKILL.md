---
version: 0.2.1
name: dev-loop-research
description: Standalone research agent — scans repo health and vault health, outputs prioritized work-item recommendations. Pass "high" for aggressive mode.
---

# dev-loop-research

Standalone invocable research agent. Scans two parallel tracks — code health
and vault health — cross-references findings, and outputs a prioritized
work-item recommendation list.

## When This Skill Activates

- User runs `/dev-loop-research` or `/dev-loop-research high`
- User wants a one-shot research scan of repo and vault health
- User schedules recurring background scans: `/loop 1h dev-loop-research`
- Dev-loop idle path delegates here (same logic, different trigger)

## Intensity

Parse arguments for `high` (case-insensitive). If present,
**intensity = high**; otherwise **intensity = normal**.

- **normal**: Output top-3 items. Suppress recurring findings that haven't
  changed since last pass. Respect priority gates.
- **high**: Output top-5 items. Never suppress recurring findings. Every
  finding is actionable regardless of priority tier. P4+ items are
  first-class.

## Prerequisites

1. **Project config** — load `./.claude/dev-loop.config.md`. Required
   fields: `slug`. Optional: `vault`, `cli_src`, `cli_test`,
   `skills_glob`. If missing, prompt user to bootstrap via dev-loop.
2. **Resolve BACKEND_CAPS** from `knowledge_layer` config field (default:
   `skillwiki` if vault exists, `none` otherwise).
3. **Resolve VAULT_TYPES** from `{vault}/SCHEMA.md` `## Layers` section —
   extract backtick-wrapped directory names ending in `/`, exclude `raw`
   and `project`. Store for Track B.
4. Read `CLAUDE.md` and user `MEMORY.md` fresh.

## Single-Pass Cycle

```
┌───────────────────────────────────────────────────────────┐
│ 0. REFRESH                                                │
│    Load project config + read CLAUDE.md/MEMORY.md fresh   │
├─────────────────────────┬─────────────────────────────────┤
│ TRACK A: CODE HEALTH    │ TRACK B: VAULT HEALTH           │
│                         │                                 │
│ A1. CLI COVERAGE GAPS   │ B1. RAW-TO-PAGE COVERAGE        │
│ A2. SKILLS AUDIT        │ B2. CROSS-LINK DENSITY          │
│ A3. SPEC DRIFT          │ B3. PAGE QUALITY                 │
│ A4. UNPUSHED COMMITS    │ B4. TYPE COVERAGE                │
├─────────────────────────┴─────────────────────────────────┤
│ 1. VAULT RETROS (cross-cutting)                           │
│ 2. SYNTHESIZE — merge + score (P0–P3, +P4 in high)       │
│ 3. SAVE & EXIT                                            │
└───────────────────────────────────────────────────────────┘
```

Skip Track B entirely when `query_vault` not in BACKEND_CAPS or vault
is empty. Skip Track A when `cli_src` is empty.

## Track A: Code Health

### A1. CLI Coverage Gaps
- List `{cli_src}/*.ts`. For each: test file in `{cli_test}/`? `--human`
  flag? Stable exit codes? `TODO/FIXME/HACK` markers?
- Compare counts against CLAUDE.md documented counts. Flag drift.

### A2. Skills Audit
- List SKILL.md files from `skills_glob`. Check: CLI subcommand
  references exist? Description matches current behavior? Skill maps
  list all skills correctly?

### A3. Spec Drift
- If canonical spec is declared, verify scope fields against current
  code. New commands not in spec? Changed counts? New schema changes?

### A4. Unpushed Commits
- `git log origin/$RELEASE_BRANCH..HEAD --oneline`. Priority:
  ≥10→P1, 5-9→P2, 1-4→P4+.

## Track B: Vault Health

### B1. Raw-to-Page Coverage
- Run `skillwiki lint` for `wikilink_citation` warnings.
- Count raw files vs typed pages vs cited sources. Flag:
  normal: uncited >50%→P1; high: uncited >20%→P1.
- Single-source pages: normal→P2, high→P2 always.

### B2. Cross-Link Density
- Count outbound `[[wikilink]]` in body region per page.
- normal: <2 links→P2; high: <3 links→P2.
- Orphan and overlap detection via `skillwiki orphans`/`overlap`.

### B3. Page Quality
- Count non-blank body lines (exclude headings and `---`).
- normal: <40 lines→thin; high: <60 lines→thin.
- Flag missing Overview or Related sections.

### B4. Type Coverage
- Page counts per type directory. Flag: entities <3, empty comparisons,
  empty queries when >30 pages exist, empty meta when 2+ projects active.
- High: flag any empty type dir.

## Vault Retros (Track 1)

Scan `{vault}/log.md` for recent `Improve:` and `Generalize?: yes` entries.
Check `{vault}/projects/{slug}/compound/` for pending distillation work.
A retro's `Improve:` field that names a concrete action is a direct
work-item candidate.

## Synthesize (Track 2)

Score each finding:

| Score | Impact | Effort |
|-------|--------|--------|
| P0 | Spec violation or regression | Any |
| P1 | High — untested command, raw-to-page gap >50%, isolated pages | S/M |
| P2 | Medium — thin pages, skill map drift, single-source, empty type dirs | S/M |
| P3 | Low — code quality, cross-link improvement, section completeness | Any |
| P4+ | Speculative — proactive improvements, future-proofing, polish | Any |

**normal**: top-3, P0–P3 only, suppress unchanged recurring.
**high**: top-5, P0–P4+, never suppress recurring.

Output format per item:

```markdown
### #N: [title] (Px)

**Source**: [track source]
**What**: One-paragraph spec.
**Acceptance**: Bullet list of verifiable outcomes.
**Files**: Likely files to touch (omit for vault-only items).
```

## Save & Exit (Track 3)

1. Append research observation to `{vault}/log.md`:
   ```
   ## [YYYY-MM-DD HH:MM] research | dev-loop-research cycle [normal|high]
   - Findings: [N] new, [N] recurring
   - Vault health: raw=[N] pages=[N] cited=[N]% isolated=[N] thin=[N]
   - Top-N: [titles]
   ```
2. If ranked list changed since last cycle, update user MEMORY.md with
   research-backlog entry.
3. Exit with one-line summary.

## Idle Fast-Path

**Pre-idle gate (mandatory):** Before declaring idle, collect actual vault
health metrics from B1–B4. If any metric exceeds thresholds below, do NOT
report idle:

| Metric | normal | high |
|--------|--------|------|
| Uncited raw | >50% | >20% |
| Isolated pages | any | any (<3 links) |
| Thin pages | any (<40L) | any (<60L) |
| Empty type dirs | any (entities, comparisons) | any |

Three exit states:
1. **Truly idle** — zero new findings, all metrics healthy. Exit:
   `"Research idle — no new findings."`
2. **Steady backlog** — no new findings, but known gaps persist. Exit:
   `"Research steady — [N] recurring: [titles]"`
3. **High mode never idle** — always produce recommendations. If standard
   checks find nothing, generate proactive suggestions.

**NEVER report idle when vault health metrics show actionable gaps.**
