# Opt-in MCP snapshot requests

The MCP daemon only writes queue records after a successful content transaction or
file-ingress adoption. It never invokes Git, systemctl, or the snapshot pipeline.
The existing periodic `wiki-snapshot.timer` remains the fallback.

Enable only on the designated central snapshotter, with the same canonical,
absolute state directory outside every vault and outside the snapshot Git worktree.
Use an owner-controlled local directory, without symlink ancestors; both processes
need access. Do not use an S3/FUSE mount for this queue. Python 3 is required.
When MCP and the root snapshot worker use different accounts, provision the spool
and its three subdirectories with the MCP account as owner. The root worker
preserves that directory ownership on its private atomic record replacements,
so request status remains readable by MCP. The worker lock may remain root-owned.

MCP configuration (disabled by default):

```yaml
snapshot:
  enabled: true
  state_dir: /var/lib/skillwiki-snapshot-requests
  vault_id: central
```

Equivalent environment variables are `SKILLWIKI_MCP_SNAPSHOT_ENABLED=true`,
`SKILLWIKI_MCP_SNAPSHOT_STATE_DIR`, and `SKILLWIKI_MCP_SNAPSHOT_VAULT_ID`.
Extra vaults and user workspaces cannot request central snapshots. Requests use
write authorization; inventory and status use read authorization and readiness.

The snapshotter installer copies the worker and installs inert service/timer
units. Upgrades never enable this timer. The operator provisions matching access
and `/etc/vault-sync/snapshot-requests.env` separately:

```ini
SKILLWIKI_SNAPSHOT_REQUESTS_ENABLED=true
SKILLWIKI_SNAPSHOT_STATE_DIR=/var/lib/skillwiki-snapshot-requests
SKILLWIKI_SNAPSHOT_VAULT_ID=central
WIKI_DIR=/root/wiki
```

The service also loads the existing snapshotter host profile, then these overrides.
After review, enable `wiki-snapshot-requests.timer` in the installation's system or
user systemd scope. No path unit is used: failures cannot cause a hot trigger loop.
The worker invokes only its installed sibling `wiki-snapshot.sh`, preserving all
fleet, lock, deletion, and projection guards. Do not configure dry-run mode.
Runtime-only upgrades include an immutable Python launcher for the worker while
preserving existing units; provision these new units separately on such hosts.

The spool has `pending/`, `running/`, and `receipts/`, keyed by random request UUIDs.
Each run claims up to 128 eligible requests, after 5 seconds of quiet or a 60 second
maximum delay. Requests arriving during execution remain pending. A single flock
serializes workers; interrupted running claims become failed receipts and retry
with backoff. There are at most three genuine execution attempts, with
60/120/240 second backoff. An actual snapshot-lock conflict instead emits
`SNAPSHOT_LOCK_BUSY schema=v1 result=busy exit=75` and exits 75. The worker
requires both that exit code and the exact final marker, without completion proof,
before deferring for 60 seconds. It records `state=queued`,
`error=SNAPSHOT_LOCK_BUSY` and preserves the previous attempt count, including
previous genuine failures. Repeated lock conflicts cannot exhaust the retry budget.
Other flock errors, missing/malformed busy markers, timeouts and unproven snapshot
completion remain genuine failures. Already terminal requests are not revived.
A completed receipt keeps `last_failure` as the most recent genuine worker class
(`SNAPSHOT_COMPLETION_UNPROVEN` or `SNAPSHOT_INTERRUPTED`). Lock contention is
excluded. `last_failure` does not make a completed receipt unhealthy: `state=completed`,
matching head/origin, and no current `error` still mean success. The field is a
worker category; it does not name the underlying projection refusal.
Unproven runner outcomes print one stdout line
`snapshot request unproven reason=... exit=... marker=...` (systemd journal).
`reason` is `spawn_failed`, `timeout`, `proof_missing`, or `proof_mismatch`.
`marker` is the last `ERROR:` / `FAIL ` / `SNAPSHOT_*` line after stripping the
runner's `YYYY-MM-DD HH:MM:SS ` prefix, with control characters replaced by spaces
and truncated to 240 characters. Truncation is a size limit, not a privacy
guarantee. Valid lock-busy and proven completion stay quiet. Do not copy raw CLI
JSON into the summary.

Deferrals are journaled durably in every running claim before queue receipts are
updated. Recovery finishes those queued deferrals without another refund; a
partial batch journal also identifies its siblings by the shared start timestamp.
Recovery journals all such siblings before deleting any witness, preserving the
known-busy result across another crash. A crash before any busy journal is durable
still counts as an interrupted execution because its outcome is unknown.
The runner has a 900 second timeout; a timeout kills its entire isolated process
group and reaps the runner before recording failure. Completion timestamps and
retry deadlines use the clock after execution. Queue timestamps must be finite
nonnegative numbers and attempts must be integers from zero through three.
Failed receipts remain available during retries. Receipts are retained until the
operator removes them; there is no automatic retention policy in this first slice.

`wiki_snapshot_request({vault?})` returns queued, disabled, or failed. Queued means
local durable acceptance, not backup completion. Inspect a returned request UUID
with `wiki_snapshot_status({vault?,request_id?})`; without an ID the status reports
unknown, or the daemon's latest enqueue error. A completed receipt requires exit 0
and a canonical `SNAPSHOT_COMPLETE schema=v1 ... result=success` from that invocation,
with valid matching head/origin OIDs. Completed proves the pipeline ran, not that
specific page hashes are present in Git. Skip and early-exit success codes do not
qualify. A failed attempt can later become completed after a timer retry.

`wiki_inventory({vault?,after?,limit?})` returns sorted `{path,sha256}` entries and
an optional exclusive `next_after` path cursor. Limit defaults to 200, maximum
1000. Paths use the shared Markdown mirror admission policy; symlinks and secrets
are excluded. Hashes describe local discovery bytes. Fetch actual content through
`wiki_read_page`, which verifies S3. Inventory is not a consistent point-in-time
snapshot; clients repeat it on every connection and periodically to recover missed
SSE events, creations, and daemon restarts. No changes-since API or durable event
history is provided. Inventory refuses scans above 200,000 directory entries.

Inventory continuation requests may reuse a bounded path index for up to 30 seconds (at most eight roots); an initial page rebuilds it. File bytes and ancestry are validated afresh for each response. Files larger than 256 KiB or changing during hashing are omitted and can be retried in a later scan.
