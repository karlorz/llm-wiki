# ADR 0001: Version Identity Is the S3 Object

## Status

Accepted

## Date

2026-09-14

## Context

The centralized HTTP MCP server (`skillwiki-mcp-http`) serves as the remote access plane for agents reading and mutating wiki state. Mutating tools (`wiki_workitem_write`, `wiki_page_publish`) employ Compare-And-Swap (CAS) semantics via a required `base_sha256` parameter to prevent concurrent write collisions and accidental clobbers.

In the original daemon architecture:
1. The daemon periodically reconciles its local working copy with S3 (via rclone copy update, scheduled at 1-hour intervals).
2. CAS operations in `commitCasWrite` evaluated `base_sha256` against the working copy disk file bytes (`txn.ts`).
3. Reads in `handleWikiReadPage` computed `sha256` from working copy disk bytes (`reads.ts`).

However, human operators and local scripts can push updates to S3 at any time (`wiki-push.sh`), running outside the daemon's local working copy. If S3 receives an update from a human push while the daemon working copy remains stale (up to 1 hour before the next periodic reconcile), an agent submitting a CAS write based on a stale local working-copy read could overwrite fresh human edits in S3, or vice versa.

Therefore, the local working copy cannot be the canonical source of truth for version identity. The version authority must be S3.

## Decision

1. **S3 Object as Version Authority**: The canonical identity of a document's version is defined by the content bytes stored in the backing S3 bucket (`s3Prefix/relPath`).
2. **Single S3 Round-Trip via `GetObject` + sha256**:
   - SeaweedFS S3 ETags do not guarantee a content sha256 (they may reflect internal chunking, MD5, or multipart signatures).
   - Therefore, `currentVersion` queries S3 via `GetObjectCommand` and computes the sha256 of the fetched byte stream in memory.
   - We avoid an extra `HEAD` round-trip; a single `GetObject` retrieves the object bytes, computes the sha256, and supplies the canonical version in one network trip.
3. **Single-Path Working Copy Refresh**:
   - When checking `currentVersion` for a given path, if the local working copy bytes differ from the S3 object bytes (or if the local file is missing while present in S3), the daemon refreshes only that specific path in the working copy using an atomic temp-file-and-rename pattern (`writeAtomicPath`).
   - The daemon does not invoke a full-vault rclone sync during point lookups.
4. **Fail-Closed Writes**:
   - During CAS evaluations (`commitCasWrite`), S3 reachability is mandatory.
   - If S3 is unreachable or returns an error, the write transaction fails closed with `S3PutError` (error code `S3_PUT_FAILED`).
   - There is no silent fallback to local working-copy comparison during CAS writes. The working copy remains untouched.
5. **Degraded Reads with Verification Flag**:
   - For `wiki_read_page`, the server attempts to fetch and verify the version against S3.
   - On S3 success, the tool returns the fresh content and sha256, setting `s3_verified: true`.
   - On S3 unreachability, reads degrade gracefully: the daemon serves local working-copy bytes with `s3_verified: false`, allowing read-only inspection even during network partitions.

## Consequences

### Positive
- Prevents split-brain and stale-base overwrites between human git/S3 pushes and daemon MCP writes.
- Guarantees immediate consistency for CAS writes: every CAS check validates against current S3 state.
- Working copy automatically converges on accessed paths without waiting for periodic rclone syncs.
- Clear contract for agents via `s3_verified`: clients know if read versions reflect confirmed remote authority.

### Negative / Trade-offs
- One extra S3 `GetObject` round-trip per read (`wiki_read_page`) and per CAS write. Network latency to S3 is incurred on these calls.
- When S3 is unavailable, CAS writes fail completely (intentional fail-closed safety invariant).
