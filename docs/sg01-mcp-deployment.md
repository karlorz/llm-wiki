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

The command exports the exact ref, stages it separately under `/opt`, installs locked dependencies, and builds both runtimes referenced by enabled sg01 units:

- `packages/mcp-server/dist/server.js`
- `packages/agent-memory-trends/dist/cli.js`

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

Require the handshake to advertise the released version and fourteen tools. On sg01, confirm the MCP service has no restart/error loop, that `skillwiki-backend.target` (and its member units) remains enabled, and that the research/session-brief timers still reference existing runtime files. Observe or attend one normal research and session-brief run before pruning rollback bundles.

## Multi-vault (Identity A)

One HTTP MCP process may serve a default central vault plus explicit extra `vault_id`s (S3 prefixes and unique local roots). Handshake advertises `default_vault` and `allowed_vaults`. Clients keep **one** connector URL and pass optional `vault=` on tools; omit means the authorized default.

Grok Bot **Plugins → Configure** fields:

| Field | Secret? | Role |
| --- | --- | --- |
| `SKILLWIKI_MCP_TOKEN` | yes | Host bearer. Never a vault list. |
| `SKILLWIKI_EXTRA_VAULTS` | no | Comma-separated extra vault ids the client may request. Default central is always on. Does not authorize access. |

Server `allowed_vaults` on the principal is the security boundary. Unknown, disabled, or unauthorized vault ids fail closed before filesystem/S3 I/O. Snapshot, FUSE, research, session-brief, rclone scheduling, and Git promotion stay sibling processes (`skillwiki-backend.target` groups lifecycle only). HTTP MCP still does not grow archive/remove/source-dispose/index/fleet/history mutations.

Do not treat this document as a Slice 6 `wiki-fin` cutover. Production extra-vault provision, Hermes schedule change, and sg01 deploy remain a later attended pass.
