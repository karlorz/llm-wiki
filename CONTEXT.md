# llm-wiki Context

Domain language for SkillWiki project-work lifecycle, evidence, and knowledge ownership.

## Language

**Delivery lifecycle**:
The state of approved work from `planned` through `in-progress` to `completed` or `abandoned`. Work-item `status` describes delivery, not every possible future observation.

**Required acceptance verification**:
Evidence that must pass before delivery is complete. A failed or missing required acceptance check keeps the work active.

**Post-release verification**:
Optional evidence gathered after delivery is already complete. It does not keep a delivered work item active.

**Verification posture**:
The policy controlling whether post-release verification is expected. The supported posture is `opt-in`.

**Verification trigger**:
An event that resurfaces opt-in verification: a matching regression report, an explicit user request, or a relevant code or release change after the last proof.

**Ranked audit report**:
A read-only evidence packet that classifies active project work without changing lifecycle state.

**Lifecycle reconciliation**:
An attended decision process that reviews ranked-audit evidence, resolves ambiguous verdicts, and applies approved lifecycle corrections only after final batch approval.

## Relationships

- Delivery lifecycle owns active-work ranking eligibility.
- Required acceptance verification is part of delivery lifecycle.
- Post-release verification follows delivery lifecycle and is governed by verification posture and triggers.
- Ranked audit reports inform lifecycle reconciliation but do not authorize mutation.
- SkillWiki owns lifecycle truth, validation, evidence shape, and managed vault mutation; orchestration systems consume those contracts.
