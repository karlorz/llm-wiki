# Clip-outbox worker and attended migration

The channel remains disabled by default. Installing or updating npm ships the
worker and launchd template; it does not change `clip_outbox.enabled`, load a
job, import browser settings, or enable wiki-push. `skillwiki doctor` reports
**clip channel not configured** until attended setup is complete.

After upgrading the CLI, refresh the host plist explicitly:

```sh
skillwiki clip-outbox install-or-migrate
skillwiki doctor
```

This writes or refreshes
`~/Library/LaunchAgents/com.karlchow.skillwiki-clip-outbox.plist` from the new
package. It preserves host configuration and does not call launchctl. Existing
customizations to this dedicated plist are replaced by the packaged template.
Its arguments use the absolute installed Node executable and npm `skillwiki`
bin symlink (including `/opt/homebrew/bin/skillwiki`); npm version upgrades keep
that bin path. WatchPaths expands the configured outbox root. KeepAlive and
RunAtLoad supervise the worker; WatchPaths only aids wakeup. The actual recursive
watch is native macOS FSEvents. If Node's installation prefix changes, rerun the
migration. Installing with `--omit=optional` omits FSEvents and the worker fails
closed instead of switching to polling.

## Before operator enablement

1. Create/select the dedicated `~/Obsidian/clip-outbox` Obsidian vault, with
   `raw/articles` and `raw/assets`. Never select `~/wiki`. Import the existing
   clipper template separately in every browser profile and confirm scratch
   captures arrive in this outbox. Startup scans discover files already there;
   move historical backlog elsewhere until an attended exact-file selection is
   implemented. Do not copy a historical vault into the dedicated outbox.
2. Configure the existing `clip_outbox.*` namespace: `root`, `state_root`,
   `mirror_root`, `ready_url`, `s3_credential_ref`, `ready_credential_ref`, and
   either an inventoried `d8_note_root` or explicit `d8_note_absent=true`.
   Leave `enabled=false` throughout preparation. State lives outside both
   vaults, for example `~/Library/Application Support/SkillWiki/clip-outbox`;
   create its parent first. The resolver enforces disjoint roots and the fixed
   `central` / `seaweed-wiki:cloud/wiki` destination. The mirror freeze marker
   must exist and `vault_sync.push_enabled=false` must remain set, with the
   wiki-push job unloaded.
3. Install separately scoped credentials in the operator-owned, mode-0600 host
   file `~/.skillwiki/clip-outbox-credentials.json`. It is a JSON provider map:
   the name referenced by `s3_credential_ref` maps to an object with `endpoint`,
   optional `region` (default `us-east-1`), `accessKeyId`, `secretAccessKey`, and
   optional `sessionToken`; the name referenced by `ready_credential_ref` maps
   to the separately issued file-ingress token string. References may instead
   resolve from service environment variables (S3 value is the same JSON object
   encoded as text). Never place values in a plist, vault page, or command line.
   Launchd does not inherit an interactive shell's exports, so prefer the
   protected file for unattended operation. An MCP token is rejected as the
   file token, including one stored only in the host `.env` file.
4. Provision S3 permissions for create-only article/asset writes and hash
   readback, plus read-only access to `wiki/meta/delete-intents/` for the exact
   path and ancestor admission checks. Missing/unknown delete-intent access
   blocks publication. Prove concurrent **If-None-Match: \*** creation on the
   deployed SeaweedFS endpoint: one writer wins, identical retries reuse bytes,
   different bytes cannot replace them. Verify the destination binding and
   independent file-ingress notifier token. Local unit tests are not deployed
   conditional-create evidence.
5. After those checks, the operator explicitly sets `clip_outbox.enabled=true`
   using `skillwiki config set`, then explicitly requests loading:

   ```sh
   skillwiki clip-outbox install-or-migrate --load --conditional-create-proven
   skillwiki doctor
   skillwiki clip-outbox status
   ```

   `--conditional-create-proven` is an operator attestation of the deployed race
   test, not a test performed by this command. It records a non-secret receipt
   bound to the endpoint and destination outside the vault. Both flags and the
   existing enable setting are required for loading. The foreground
   `skillwiki clip-outbox watch` command requires the same valid configuration
   and recorded evidence. A different endpoint invalidates the receipt.

## Worker behavior and recovery

The worker subscribes before one startup journal/root scan. FSEvents coalescing,
directory-level events, overflow/drop/root-change flags trigger a recovery scan.
Normal file events use 500 ms quiet debounce and matching complete input hashes
500 ms apart. It localizes images with the existing guarded helper, rechecks the
article and every referenced local binary, and seals exact snapshots outside
raw. Original input bytes are retained there too; the capture input is not
rewritten. New article keys include a date and random capture identity; existing
local asset paths are preserved. The sibling asset `note.md` is included.

Sealing enters one serial publication queue immediately. Every asset, including
the index, is conditionally created and read back for SHA-256 verification before
the article. Each verified object gets a durable journal receipt. Unknown PUT
outcomes are inspected before retry. Conflicts and auth/admission failures hold
the item; transient failures use jittered exponential backoff from about one
second to at most 60 seconds. No minute/hour timer participates in normal
publication. The optional hourly root scan is recovery only; disable it with
`clip_outbox.poll_fallback_enabled=false` for an isolated realtime rehearsal.

After article verification, the worker immediately POSTs the v0.10.110 ready
contract (`vault_id`, `files` with exact paths/hashes) to `/file-ingress/ready`.
It sends no article or binary content. A failed/unknown hint stays
`notify-pending`; restart retries that notification without uploading verified
objects again. Only a verified response accounting for every path records
`central-visible`. The worker never infers `mirrored`; confirm central pending
inventory, SSE, exact mirror hashes and image preview separately.

`clip-outbox status` lists capture identities, journal states, redacted reason
codes and attempts. Edits to an already sealed input report
`SEALED_SOURCE_CHANGED`; the sealed snapshot and published keys remain fixed.
A corrupt journal or incomplete worker lock stops startup for attended recovery.
Do not delete a journal/lock while a worker is running. Queue data and receipts
are retained indefinitely in this slice (there is no automatic pruning), which
also preserves the required seven-day minimum and all undelivered/conflicted
items. Disabling the job retains that evidence; it never deletes cloud raw.

A successful upload proves S3 storage; a successful ready adoption proves
central materialization. Mirror freshness and pending-source visibility still
require the isolated end-to-end rollout checks. Neither this migration nor the
worker unfreezes the mirror, calls wiki_capture, or runs wiki-push.
