# sg01 HTTP MCP deployment

sg01 runs the production SkillWiki HTTP MCP daemon as native systemd. Coolify is not part of this deployment path.

## Command

Preview an exact release tag:

```bash
bash scripts/deploy-sg01-mcp.sh --ref v0.10.95
```

Deploy after the preview and release CI are green:

```bash
bash scripts/deploy-sg01-mcp.sh --ref v0.10.95 --execute
```

The command exports the exact ref, stages it separately under `/opt`, installs locked dependencies, and builds the runtimes used by enabled sg01 units:

- `packages/mcp-server/dist/server.js`
- `packages/agent-memory-trends/dist/cli.js`
- `packages/cli/dist/cli.js` (session-brief-mcp prefers this bundled CLI over a lagging global `/usr/bin/skillwiki`)

It atomically swaps `/opt/llm-wiki`, restarts only `skillwiki-mcp.service`, and preserves the previous bundle for rollback. It does not alter FUSE, snapshotter, research timers, session-brief timers, credentials, or vault content. The systemd family target `skillwiki-backend.target` groups the member units on sg01 while restarts remain strictly MCP-only.

## Readiness gate

The initial MCP reconcile runs:

```text
rclone copy --update <S3 vault> /opt/skillwiki-mcp/vault
```

The production vault currently has more than 22,000 objects. A normal initial scan takes about 107 seconds. The deployment gate therefore defaults to **600 seconds**, matching the daemon's default rclone timeout. A 90-second gate is invalid and causes a false rollback.

Deployment succeeds only when all of these are true:

- `skillwiki-mcp.service` is active
- `/health` reports `reconcile_ready=true`
- `.deploy-pin` matches the requested ref
- MCP and agent-memory runtime files exist

A staging/build failure before the swap leaves the live bundle and service untouched. Any failure or interruption after the swap restores the previous `/opt/llm-wiki` and restarts the old service. A daemon that enters systemd's failed state triggers immediate rollback rather than waiting for the full readiness deadline.

## Post-deploy verification

From macos-dev:

```bash
skillwiki doctor --check-mcp
```

Require the handshake to advertise the released version and fourteen tools. On sg01, confirm the MCP service has no restart/error loop, that `skillwiki-backend.target` (and its member units) remains enabled, and that the research/session-brief timers still reference existing runtime files. The deploy script still restarts only `skillwiki-mcp.service`; it must not auto-start or restart either sibling oneshot.

For an attended post-deploy proof, the operator separately verifies the sibling jobs:

1. Confirm `/opt/llm-wiki/packages/agent-memory-trends/dist/cli.js` and `/opt/llm-wiki/packages/cli/dist/cli.js` exist under the swapped bundle. `session-brief-mcp` must invoke that bundled CLI (or `AGENT_MEMORY_TRENDS_SKILLWIKI_BIN`), not a lagging global `skillwiki`.
2. Start `skillwiki-research.service` once. Its checked-in command remains `daily --generate-only --mcp-publish --synthesis-fallback none` and must run as deterministic collector-packet mode without Codex or Claude.
3. Inspect `/var/lib/skillwiki-research/staging-vault/.skillwiki/agent-memory-trends/latest-run.json`. Accept either a non-quiet success with `selected_candidate_count > 0` and a packet readable through `wiki_read_page`, or a quiet success with zero selected and no packet.
4. Verify collector mode produced no `queries/YYYY-MM-DD-agent-memory-trends-digest.md` and no proposal capture. The packet, when present, must use canonical published URLs rather than host-local `raw/articles/**` citations.
5. Start `skillwiki-session-brief.service` once, then read `meta/latest-session-brief.md` through MCP. Confirm **Latest Collector Run** links the exact packet or records the quiet receipt, and **Latest Judged Agent Memory Trends** remains digest-only.
6. Confirm the MCP writer receipt is `sg01-research` and record the two oneshot journal excerpts in the active work-item log.

Do not copy `.skillwiki/**` into the MCP vault, expand the MCP allowlist, install Codex/Claude on sg01, or modify `scripts/deploy-sg01-mcp.sh` to restart sibling jobs.

## Multi-vault (Identity A)

One HTTP MCP process may serve a default central vault plus explicit extra `vault_id`s (S3 prefixes and unique local roots). Handshake advertises `default_vault` and `allowed_vaults`. Clients keep **one** connector URL and pass optional `vault=` on tools; omit means the authorized default.

Grok Bot **Plugins → Configure** fields:

| Field | Secret? | Role |
| --- | --- | --- |
| `SKILLWIKI_MCP_TOKEN` | yes | Host bearer. Never a vault list. |
| `SKILLWIKI_EXTRA_VAULTS` | no | Comma-separated extra vault ids the client may request. Default central is always on. Does not authorize access. |

Server `allowed_vaults` on the principal is the security boundary. Unknown, disabled, or unauthorized vault ids fail closed before filesystem/S3 I/O. Snapshot, FUSE, research, session-brief, rclone scheduling, and Git promotion stay sibling processes (`skillwiki-backend.target` groups lifecycle only). HTTP MCP still does not grow archive/remove/source-dispose/index/fleet/history mutations.

Grok Bot **Plugins → Configure** may set non-secret `SKILLWIKI_EXTRA_VAULTS=wiki-fin` on the same connector. That is client opt-in only. Server `allowed_vaults` remains the gate. Issue a wiki-fin-only host bearer with `skillwiki mcp-auth issue-host --host-id grok-bot-wiki-fin --allowed-vaults wiki-fin --write` on metal; do not add wiki-fin to macos-dev. In-repo example YAML stays `enabled: false` until the live `cloud/wiki-fin` prefix exists.
