# Immediate Markdown mirror delivery

Direct materialization requires macOS or Linux; Windows refuses before writing
because the publication contract requires POSIX directory fsync. Windows clients
can still request and inspect the remote Linux snapshot pipeline.

For a Git-snapshot-only checkout such as Karl's `/Users/karlchow/wiki`, keep direct
mirror listeners disabled and read fresh content through central MCP. Let the
designated snapshotter promote to GitHub and the managed local Git updater apply
the result. The frozen marker prevents agent authoring; it is not an OS read-only
mount and does not itself prevent an explicitly invoked mirror from writing.

`skillwiki sync refresh` retrieves complete page bytes through the authenticated MCP SDK and `wiki_read_page`, then verifies the returned path, SHA-256 and `s3_verified` before delivery. It uses `SKILLWIKI_MCP_URL` and `SKILLWIKI_MCP_TOKEN` (environment or `~/.skillwiki/.env`). Clip-outbox storage credentials are not involved.

```sh
skillwiki sync refresh concepts/example.md projects/llm-wiki/README.md
skillwiki sync refresh concepts/example.md --root /absolute/local/wiki --vault-id central
skillwiki sync refresh concepts/example.md --request-snapshot
skillwiki sync mirror-watch --root /absolute/local/wiki --vault-id central
skillwiki sync snapshot-request --vault-id central
skillwiki sync snapshot-status REQUEST_ID --vault-id central
```

`--wiki` selects a local profile; `--root` overrides its local mirror path. `--vault-id` is the explicit MCP vault selector and defaults to `central`. Every read, inventory and snapshot tool call sends that selector. A returned vault ID must agree when present; inventory requires it.

The local root must already exist and contain a regular `.WIKI_GIT_FROZEN` marker. The client does not unfreeze it. Absolute page paths, traversal, backslashes, instruction filenames (case insensitive), hidden/configuration paths, symlinks in the root or destination ancestry, hard-linked destination files and case-only collisions are refused. Maintained Markdown families are the admitted root pages, typed directories and project pages; `raw/` Markdown is create-only. Existing identical bytes are idempotent. Maintained pages can replace only bytes matching the previous successful delivery hash or the Git HEAD base. Divergent local bytes produce a visible conflict. Remote absence never deletes local content.

Deliveries share the `wiki-fetch/pull.lock.d` mutex with wiki-fetch and the clip mirror. Remote reads and byte verification occur before acquiring it; each path acquires the mutex only for a fresh hash-state load, local materialization and state save, then releases it. A stalled remote read leaves the local mutex available to other callers. Hash state lives under the host's vault-sync cache, scoped by canonical mirror root and vault ID, and is replaced atomically. Corrupt or mismatched state grants no replacement permission. Writes first fill and fsync an exclusive temporary file in the destination directory. Immediately before publication, the client rechecks no-follow ancestry, destination inode identity and complete original bytes. Maintained replacements publish with atomic rename under the cooperative mutex; create-only paths publish with an exclusive hard link of the complete temporary file. The parent directory is fsynced and final bytes and inode are verified. Failed publication cleans temporary bytes and leaves an existing complete destination intact. These cooperative checks are not an OS compare-and-swap guarantee against a hostile writer. Abrupt process termination can leave a hidden staging file, but does not expose a partially written destination.

The foreground watcher is opt-in: no daemon or launch agent is installed. It filters `/events` changed events for the selected vault. On each connection it starts an inventory scan, and it reconciles periodically (60 seconds). Each tick fetches one inventory page of up to 100 entries, retaining the cursor for the next tick. Inventory runs independently of SSE consumption and the serialized delivery worker. A matching inventory SHA-256 skips discovery delivery only after validating the local path, root ancestry and no-follow file bytes; it makes no new S3 verification claim. Changed or absent local pages still require a complete verified `wiki_read_page` response. Live events have priority over discovery paths. Retryable failures rotate into the next reconciliation tick, so persistent failures cannot hold the front of the queue. Missing, too-large, denied and conflicting pages leave the immediate queue; periodic inventory or a new event can rediscover them. Reconnect uses exponential backoff up to 30 seconds. SIGINT/SIGTERM cancels the stream and backoff. Per-path reports and conflicts are emitted as JSON; unavailable inventory APIs produce a visible upgrade/retry error. There is no changes-since dependency. After restart, inventory reconstructs pending work.

Reports distinguish three observations:

- `central`: the result of the current MCP read and byte verification.
- `local`: delivery, idempotence, conflict, denial or another delivery failure.
- `github`: an explicitly **cached origin-ref observation** from local Git objects. No fetch or live GitHub check occurs, and this is never live backup confirmation.

Refresh exits nonzero if any requested page fails or conflicts, or an optional snapshot request fails, while preserving successful page receipts in the result. A snapshot request's `queued` state means queue acceptance. Snapshot status `completed` proves that a pipeline run completed; it does not prove that the exact requested page bytes reached GitHub. Older servers without snapshot APIs report an error independently of successful local delivery.

Inventory continuation pages advance between live event processing, while completed scans restart on the periodic interval. The server caches discovery paths for continuation pages for at most 30 seconds; the first page always rebuilds the index, and selected file hashes are checked afresh.
