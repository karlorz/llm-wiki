# llm-wiki Spec Recommendation Report

**Date:** 2026-05-03  
**Target spec reviewed:** `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md`  
**Reviewer mode:** `superpowers:brainstorming` (recommendation-first, patch-second)  
**Primary delivery target:** Single v1 release plan that is fully executable end-to-end in one run

---

## TL;DR

The current spec is strategically strong (clear architecture direction, good compatibility positioning, explicit v1/v1.1/v1.2 boundaries), but still underspecified for smooth execution when paired with `writing-plans` constraints.

The revision should keep the same product intent (TypeScript `skillwiki` + 10 skills + Hermes wire-compatibility), while tightening:

1. **Execution contracts** (what must be deterministic vs prompt-reasoned).
2. **Security contract precision** (what `fetch-guard` enforces vs what ingest enforces).
3. **Scope lock for v1** (single-run delivery constraints and explicit out-of-scope edges).
4. **Acceptance criteria** (pass/fail checks that map directly to implementation tasks).
5. **Spec-to-plan mapping** (so one-file implementation plan can be complete, not scaffolded).

---

## 1) Executive Summary

### What is already strong

- Clear canonical intent and supersession of old architecture.
- Explicit design decisions with rationale (project-aware layer + unified knowledge layer).
- Practical deliverable layout (`packages/skills`, `packages/cli`, templates).
- Good forward compatibility framing with Hermes and additive fields.
- Good roadmap partitioning (`v1`, `v1.1`, `v1.2+`).

### What currently blocks smooth delivery

- Some key contracts are described conceptually but not bounded as executable requirements.
- Security language is stronger than currently operationalized behavior in planning artifacts.
- Success criteria are distributed across sections instead of defined as a single acceptance checklist.
- The spec permits multiple valid implementations in critical areas, increasing drift risk.
- One-file implementation planning (your chosen target) requires tighter spec determinism.

### Recommended strategy

- Keep architecture and scope foundation intact.
- Convert conceptual requirements into **testable v1 contracts**.
- Add a strict **Normative Requirements** section (`MUST`, `SHOULD`, `MUST NOT`).
- Add **v1 Definition of Done** with measurable criteria.
- Add an explicit **spec-to-plan traceability table** for one-file full execution.

---

## 2) Compliance Matrix (Brainstorming + Writing-Plans Readiness)

This matrix evaluates whether the current spec is ready to drive a one-file, end-to-end executable implementation plan.

| Area | Current State | Risk | Recommendation |
|---|---|---|---|
| Problem framing | Strong | Low | Keep |
| Architecture statement | Strong | Low | Keep with minor simplification wording |
| Bounded v1 scope | Medium | Medium | Add strict in/out boundary table |
| Deterministic CLI contract | Medium | High | Add command-level behavioral invariants |
| Security contract (`fetch-guard`) | Medium | High | Split network guard vs content guard responsibilities |
| Schema authority | Strong | Medium | Add normative field requirement matrix |
| Skill behavior requirements | Medium | Medium | Define required checks per skill in MUST language |
| Compatibility claims | Strong | Medium | Add concrete compatibility test criteria |
| Operational acceptance criteria | Weak | High | Add single DoD checklist |
| Spec->Plan traceability | Weak | High | Add explicit mapping table |

---

## 3) Deliverability Risk Matrix

| ID | Severity | Risk | Why It Matters | Required Spec Fix |
|---|---|---|---|---|
| R1 | High | Contract ambiguity in deterministic commands | Engineers can implement differently and all claim compliance | Add command-by-command normative behavior and error codes |
| R2 | High | Security requirements not precisely partitioned | Gaps between URL validation and fetch-time enforcement | Define two-layer security contract (preflight + fetch execution limits) |
| R3 | High | No unified v1 acceptance gate | Work can “look done” but fail interoperability or safety | Add DoD section with mandatory verification checklist |
| R4 | High | One-file execution requires dense clarity | Any vague area turns into re-planning during execution | Add traceability and strict “no implicit behavior” language |
| R5 | Medium | Deferred roadmap items still influence v1 phrasing | Scope creep risk during implementation | Add anti-creep notes per deferred item |
| R6 | Medium | Skill prompts rely on interpretation | Inconsistent behavior across workers | Add required sequencing and failure conditions for each skill |
| R7 | Medium | Cross-doc drift (repo notes vs revised spec) | Contributors may follow stale documents | Add canonicality notice and superseded references section |

---

## 4) Recommended Decision Set (Keep / Change / Remove / Defer)

### Keep (no functional change)

- `skillwiki` TypeScript CLI strategy.
- 10-skill model (`wiki-*` + `proj-*`).
- Unified knowledge layer with provenance tracking.
- Hermes wire-compatibility objective and additive-field philosophy.
- npm workspaces package layout.

### Change (tighten for delivery)

1. Add **Normative Requirements** with RFC-style language (`MUST`, `SHOULD`, `MUST NOT`).
2. Add **Security Contract Split**:
   - URL/network preflight guard responsibility.
   - Fetch execution constraints responsibility (timeouts, byte limits, fail-closed).
3. Add **Deterministic Command Contracts**:
   - Inputs, outputs, exit codes, error classes, idempotency expectations.
4. Add **v1 Definition of Done**:
   - Required tests and verification commands.
5. Add **Spec-to-Plan Traceability Table**:
   - Every requirement maps to one or more plan tasks.

### Remove (or reword)

- Any wording that implies “implementation can decide later.”
- Any claim language that is broader than what v1 actually guarantees.

### Defer (explicitly preserved)

- E1 two-step ingest.
- `tag-sync` and lint hook.
- `views/` starter pack.
- `purpose.md` directional layer.
- multi-format extraction.
- MCP server package.

---

## 5) Patch Blueprint for `2026-05-02-llm-wiki-skill-design.md`

Apply the following structural revisions to the existing spec file.

### A. Add section: `Normative Requirements (v1)`

Add a section near the top (after scope) with concise bullet requirements:

- `skillwiki` CLI commands **MUST** produce machine-readable JSON by default.
- Commands **MUST** return stable non-zero exit codes for failure classes.
- `wiki-ingest` **MUST** perform guard validation before any remote fetch.
- Generated pages **MUST** pass schema validation before index/log updates.
- `index.md` and `log.md` **MUST** be updated atomically with content updates.
- Raw sources **MUST NOT** be modified after ingestion (append-only metadata exceptions must be declared if allowed).
- Hermes-required fields **MUST** remain untouched in name and meaning.

### B. Add section: `Security Model (v1 Boundaries)`

Define security layers explicitly:

1. **Layer 1: URL/network preflight** (`fetch-guard`)
- Allowed schemes.
- blocked host/IP classes.
- credential stripping policy.
- malformed URL behavior.

2. **Layer 2: Fetch execution controls** (ingest flow)
- request timeout.
- max byte limit.
- redirect policy.
- fail-closed behavior.

3. **Threat assumptions and non-goals**
- what v1 does not protect against.

### C. Add section: `Command Contracts`

For each subcommand (`hash`, `fetch-guard`, `validate`, `graph build`, `overlap`, `orphans`, `audit`, `install`), define:

- Inputs (required args/options).
- Output JSON schema (high-level fields).
- Exit codes.
- Determinism expectation.
- Idempotency/side effects.

### D. Add section: `Skill Execution Contracts`

For each `wiki-*` and `proj-*` skill, define required sequencing and failure behavior.

Example pattern:

- Pre-orientation required reads.
- deterministic commands that MUST run.
- write ordering constraints.
- rollback/stop conditions.
- logging/index update requirements.

### E. Add section: `Definition of Done (v1)`

Single pass/fail checklist:

- CLI tests green.
- schema validation fixtures pass.
- security guard tests pass.
- Hermes compatibility integration test passes.
- installer dry-run and real install smoke pass.
- all 10 SKILL.md files present and validate against declared structure.
- docs updated and canonical references consistent.

### F. Add section: `Traceability to Implementation Plan`

Add a table:

| Spec Requirement ID | Description | Planned Task ID |
|---|---|---|
| SR-001 | JSON output contract | P1-Tx |
| SR-002 | Guard-before-fetch | P1-Ty |
| ... | ... | ... |

Purpose: enforce one-file plan completeness.

### G. Add section: `Superseded Artifacts and Canonicality`

List known stale doc families and canonical source of truth to reduce drift.

---

## 6) Recommended Revised Spec Outline

Use this exact target outline for the patched spec:

1. Title + status + canonicality notice
2. TL;DR
3. Design decisions (locked)
4. Scope (in-v1 / deferred)
5. **Normative Requirements (v1)**
6. Vault architecture
7. Frontmatter schemas
8. Citation conventions
9. Skill inventory
10. **Security model (v1 boundaries)**
11. **Command contracts**
12. **Skill execution contracts**
13. Hermes compatibility guarantee
14. Migration policy
15. **Definition of Done (v1)**
16. **Traceability to implementation plan**
17. Roadmap
18. Sources
19. Revision log

---

## 7) Acceptance Criteria for the Spec Revision

The revised spec is considered successful only if all conditions below are true:

1. Every v1 requirement is explicit and testable.
2. Security behavior is split between preflight and fetch execution controls.
3. Each command has documented inputs/outputs/error semantics.
4. Each skill has a defined minimal execution contract.
5. A DoD checklist exists with objective pass/fail checks.
6. A traceability table maps requirements to future plan tasks.
7. Deferred items are explicitly non-blocking for v1 execution.
8. No placeholder language remains in normative sections.

---

## 8) Transition Plan to Writing-Plans (Single-File End-to-End)

After spec revision approval:

1. Keep one implementation plan file (your requirement).
2. Expand every phase to full `writing-plans` granularity:
   - failing test
   - run fail
   - minimal implementation
   - run pass
   - commit
3. No scaffold-only phases.
4. No “expand later” notes.
5. Ensure all tasks include exact file paths, exact commands, and expected outcomes.
6. Include final verification sweep and release guard checklist.

---

## 9) Recommended Immediate Next Action

Revise `docs/superpowers/specs/2026-05-02-llm-wiki-skill-design.md` in-place using this report as the patch blueprint, then run a strict self-review against the acceptance criteria in Section 7 before touching the plan.

