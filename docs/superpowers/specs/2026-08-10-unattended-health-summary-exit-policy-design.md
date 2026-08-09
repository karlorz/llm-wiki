# Unattended Health-Summary Exit Policy Design

Date: 2026-08-10
Status: approved design, pending written-spec review
Scope: `@skillwiki/maintenance` unattended daily orchestration

## Context

The `sg02` agent-memory trends timer was restored and successfully completed its
real writing transaction on 2026-08-10. The daily job selected one candidate,
exercised the configured provider retry and fallback path, committed the trend
digest and evidence, pushed the maintenance commit, and left the vault clean and
synchronized.

The systemd service nevertheless exited with `MAINTENANCE_FAILED` because the
post-push `health-summary` reported existing vault content-integrity debt. This
creates a misleading operational state: the scheduled writer and publisher are
healthy, but systemd reports the runner itself as failed because of repository
content debt that the runner did not introduce and cannot repair within the
transaction.

The health report must remain visible. The change is only to the unattended
daily profile's final exit policy for a successfully executed and parsed health
report. The selected scope does not attempt to attribute each finding to the
current transaction. It must not weaken synchronization, writer, commit, push,
or health-tool execution failures.

## Goals

- Leave the unattended daily systemd service successful when its writer and
  push succeed but the parsed health report contains existing blocking findings.
- Preserve the complete health report, risk flags, counts, and human hint in
  maintenance events and logs.
- Continue to fail when the health command cannot execute or its report cannot
  be read or parsed.
- Continue to fail on vault preflight, writer, commit, and push failures.
- Preserve the current strict health behavior of the attended `full` profile.
- Express the policy through workflow-profile configuration rather than an
  ad-hoc job-name branch in the orchestrator.

## Non-goals

- No scheduler, timer, wrapper, or service redesign.
- No change to lint or health bucket classification.
- No change to the I3 human lint-detail hints or JSON envelopes.
- No automatic repair or suppression of vault health findings.
- No inherited-versus-new health-debt baseline or delta engine.
- No change to the dedicated session-brief or self-update profiles.

## Considered Approaches

### 1. Profile-aware parsed-report policy (selected)

Add an explicit workflow-profile property stating whether parsed health findings
are advisory to the profile's process outcome. Enable it only for
`unattended-daily`.

The orchestrator passes this policy to `runHealthSummary`. When the health
command executes successfully and its JSON report parses successfully, a report
whose blocking status is `error` is returned as a `warn` check for the daily
profile. The check retains the report's original `overallStatus`,
`blockingStatus`, `advisoryStatus`, risk flags, warnings, and human hint.

Command execution, report-file, and JSON parsing failures occur before report
status mapping and remain `fail`. The attended `full` profile does not enable
the policy and retains its current strict mapping.

This approach is explicit, narrow, testable, and does not conflate read-only
mutation semantics with failure severity.

### 2. Ignore every read-only job failure in the final gate

The smallest code diff would exclude all jobs listed in `readOnlyJobs` from the
orchestrator's final failure search. This would also make health command and
report parsing failures non-gating and would alter attended `full` behavior.
That scope is too broad.

### 3. Track inherited versus newly introduced health debt

The most precise long-term policy would compare pre-transaction and
post-transaction health reports and fail only on newly introduced blocking
findings. That requires persistent or transaction-local baselines, stable issue
identity, and additional concurrency rules. It is disproportionate to the O1
runner-restoration blocker and remains separate future work.

## Design

### Workflow profile

Extend `ResolvedWorkflowProfile` and its internal definition with a boolean such
as `healthFindingsAreAdvisory`.

- `unattended-daily`: `true`
- `attended-full`: `false`
- all profiles without `health-summary`: `false`

The property describes process-outcome policy, not whether the health job runs
or whether its findings are emitted.

### Health-summary mapping

Extend the `runHealthSummary` input with the profile policy. Preserve the
existing command and report-loading flow:

1. Execute `skillwiki health ... --no-fail`.
2. Fail if the command itself exits unexpectedly.
3. Fail if the report is missing, unreadable, or invalid.
4. Parse the report and derive its health status.
5. If blocking findings exist and the profile policy is strict, return `fail`.
6. If blocking findings exist and the profile policy is advisory, return
   `warn` while retaining the original blocking status and report details.
7. Continue mapping advisory-only findings to `warn` and clean findings to
   `pass`.

The reason string should state that blocking health findings are non-gating for
the current profile; it must not describe the underlying report as healthy.

### Orchestrator outcome

The orchestrator continues to aggregate check statuses exactly as it does now.
No special exclusion is added to the final gate. Because successfully parsed
health findings are mapped to `warn` in unattended daily mode, the existing
final gate still fails for:

- vault synchronization or cleanliness failures;
- trends writer, transaction, or commit failures;
- push and rebase failures;
- health command execution failures;
- health report loading or parsing failures;
- strict attended-profile blocking health findings.

### Observability

The job event remains present after the writer and push events. For parsed
blocking health findings in unattended daily mode it contains:

- `job: health-summary`;
- `status: warn`;
- a reason that identifies non-gating blocking findings;
- `overallStatus` and `blockingStatus` from the health report;
- all risk flags, warnings, counts, and the original human hint.

The final event is `finish: pass`, so systemd reflects the result of the
scheduled writer transaction while the health debt remains visible in the
journal and daily log.

### Known limitation

Without a pre-transaction health baseline, the daily profile cannot prove
whether an individual finding predated the transaction. A successfully parsed
blocking report is therefore non-gating even if a future writer contributes to
the reported debt. The report remains explicit as a warning, but attributing
new versus inherited findings requires the separate delta-tracking design
excluded from this change.

## Testing

Update and extend focused maintenance tests to prove:

1. Unattended daily with a successful writer/push and a parsed blocking health
   report returns success.
2. Its `health-summary` check is `warn`, retains `blockingStatus: error`, and is
   emitted before a final `finish: pass` event.
3. The successful `latest-run.json` remains unchanged and the vault remains
   clean and synchronized.
4. A health command execution failure remains fatal in unattended daily mode.
5. A missing or malformed report remains fatal in unattended daily mode.
6. Attended `full` mode still treats a parsed blocking health report as fatal.
7. Existing writer, transaction, preflight, rebase, and push failure tests remain
   green.

Required verification:

```text
npm run -w @skillwiki/maintenance test -- --run test/orchestrator.test.ts test/health-summary.test.ts
npm run -w @skillwiki/maintenance test
npm run -w @skillwiki/maintenance typecheck
npm run -w @skillwiki/maintenance build
```

The repository-wide release checks must also pass before publishing.

## Rollout and Verification

1. Implement and verify the change in the isolated worktree.
2. Review and simplify the diff without broadening scope.
3. Commit and merge through the repository's normal integration workflow.
4. Publish the next patch release and wait for release CI to finish.
5. On `sg02`, allow the self-update workflow to fast-forward the repository and
   user CLI, then refresh root-owned wrappers and units.
6. Run the unattended daily service with a clean, synchronized vault.
7. Verify writer/push success, health warning visibility, final process exit 0,
   vault cleanliness, and timer readiness.
8. Record O1 day-one evidence. Keep O1 monitoring-active until digest and brief
   freshness remain within 24 hours for three consecutive days.

## Success Criteria

- A parsed blocking health report does not overturn a successful unattended
  daily writer and push.
- The same report remains explicit and inspectable as a warning.
- Health tooling failures and all mutation-path failures remain fatal.
- Attended full-mode health semantics remain unchanged.
- `sg02` finishes the real daily service with exit 0 and a clean synchronized
  vault.
