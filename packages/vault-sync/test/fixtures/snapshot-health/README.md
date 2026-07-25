# Snapshot health scenario corpus (v1)

Shared versioned fixtures that both the shell (`status.sh`) and TypeScript
(`doctor.ts`) snapshot-health implementations must consume to enforce exact
parity on check IDs, severities, and stable structured facts.

## Schema version 1

Each scenario file is a JSON object:

```json
{
  "schema_version": 1,
  "scenario_id": "unique-kebab-id",
  "description": "human-readable summary",
  "now": "ISO-8601 instant used as the current clock",
  "cadence_minutes": 30,
  "service_timeout_seconds": 900,
  "service_scope": "user",
  "timer": {
    "load_state": "loaded",
    "unit_file_state": "enabled",
    "active_state": "active",
    "sub_state": "waiting",
    "next_elapse": "ISO-8601 or null",
    "result": "success"
  },
  "service": {
    "load_state": "loaded",
    "active_state": "inactive",
    "sub_state": "dead",
    "result": "success",
    "exec_main_status": 0,
    "exec_main_code": 1,
    "active_enter_timestamp": "ISO-8601 or null",
    "inactive_enter_timestamp": "ISO-8601 or null"
  },
  "log_records": ["line1", "line2"],
  "expected": {
    "vault_sync_jobs_enabled": { "status": "pass" },
    "vault_sync_snapshot_service_result": { "status": "pass" },
    "vault_sync_last_push_age": { "status": "pass" },
    "vault_sync_snapshot_consecutive_failures": { "status": "pass", "facts": { "count": 0 } }
  }
}
```

### Field semantics

- `now` - the deterministic clock value both implementations use for age
  calculations. Loaders inject this into the implementation's clock seam.
- `cadence_minutes` - the timer interval (shipped default 30).
- `service_timeout_seconds` - the oneshot service timeout (shipped default
  900 = 15 min). A service apparently running longer than this is an error.
- `service_scope` - `user` or `system`.
- `timer` - semantic (snake_case) properties for `wiki-snapshot.timer`.
  `null` for a property means "unavailable" (scenario 16).
- `service` - semantic properties for `wiki-snapshot.service`. Optional
  `exec_main_start_timestamp` / `exec_main_exit_timestamp` may be present;
  when omitted, fixtures rely on `active_enter_timestamp` /
  `inactive_enter_timestamp` for completed-run evidence.
- `log_records` - the bounded tail of `wiki-snapshot.log` lines to parse for
  canonical completion/failure records.

### Live systemctl adapter (v0.10.15)

Fixture keys stay snake_case for corpus stability. On the live path (no
`VS_SNAPSHOT_HEALTH_FIXTURE`), both shell and TypeScript map semantic keys to
case-sensitive systemd names (`unit_file_state` → `UnitFileState`,
`exec_main_status` → `ExecMainStatus`, `next_elapse` →
`NextElapseUSecRealtime`, etc.). Completed oneshot success requires
`Result=success`, `ExecMainStatus=0`, and non-empty completed-run evidence from
`ExecMainExitTimestamp`, `InactiveEnterTimestamp`, or `ActiveEnterTimestamp`
(live oneshots often leave `ActiveEnterTimestamp` empty). Running elapsed time
prefers `ExecMainStartTimestamp` and falls back to `ActiveEnterTimestamp`.
- `expected` - exact check ID -> `{ status, facts? }`. `status` is one of
  `pass|warn|error`. `facts` holds stable structured fields automation
  compares exactly (e.g. `count`, `outcome`). Human-readable detail may
  differ between shell and TS; only ID + status + facts must match.

### Freshness thresholds (default 30-minute cadence)

- warning age = 2 * cadence + 15-min runtime grace = 75 min
- error age   = 4 * cadence + 15-min runtime grace = 135 min

### Canonical completion record (v1)

wiki-snapshot.sh emits one stable terminal record for both pushed and
no-change success:

```
SNAPSHOT_COMPLETE schema=v1 outcome=<pushed|no-change> result=success ts=<ISO> head=<oid> origin=<oid|unknown>
```

Loaders parse the most recent `SNAPSHOT_COMPLETE` line from `log_records`.

### Required scenarios

The corpus must include at least the 18 scenarios enumerated in the v0.10.14
spec, plus scenario 19 (successful oneshot with empty `active_enter_timestamp`
and non-empty exit/inactive evidence). Scenario files are named
`NN-short-name.json` (zero-padded index).

Live-adapter tests share `fake-systemctl.sh` in this directory (PATH stub for
shell and TypeScript gates).
