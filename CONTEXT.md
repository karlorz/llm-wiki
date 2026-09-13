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

**New host**:
A machine that should write the wiki for the first time. A new chat tab on an already-provisioned machine is not a new host. A newly created VM that will write is a new host. Creating the machine is not issuance.
_Avoid_: new environment, new user, new session, new workspace

**Writer identity**:
The audited principal behind every HTTP MCP write. It is realized either by a host-id bearer (one machine) or by an OAuth grant (a web client with no host, such as ChatGPT web). Every write, audit line, and allowlist decision names exactly one writer identity.
_Avoid_: user, account, session, connector

**Host-id bearer**:
Operator-issued HTTP MCP authentication bound to one host identity; one realization of a writer identity. The client holds it in process environment or host Configure; the vault never stores the raw value.
_Avoid_: API key, plugin token, session token

**Attended issuance**:
An operator action on metal that creates a host-id bearer, shows the raw value once, and does not write client config files.
_Avoid_: auto-provision, first-run wizard, doctor apply

**Full MCP read/write**:
Live HTTP MCP tools include capture, work-item write, and page publish. A local vault mirror is optional for reads.
_Avoid_: captures-only, local git writer

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
- Writer identity is resolved once per HTTP MCP request; host-id bearer and OAuth grant are its two realizations and neither changes what a write may touch.
