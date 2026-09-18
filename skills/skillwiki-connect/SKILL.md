---
name: skillwiki-connect
description: Use skillwiki connect for unknown-agent HTTP MCP. Never init, Drive, or paste tokens.
---

# skillwiki-connect

Unknown-agent HTTP MCP setup. Use when the client has no SkillWiki plugin and no usable connector (Doubao Work cloud, headless VM). The official ingest is `skillwiki connect`. Do not paste bearers into chat. Do not run `skillwiki init`.

## When this skill activates

- An unknown agent must install CLI + unique host-id bearer and finish MCP connect.
- `SKILLWIKI_MCP_TOKEN` is missing from process env and `~/.skillwiki/.env`.
- Doctor reports auth not set, or WIKI_PATH missing on a host that should stay vault-less.

## Hard rules

- Do **not** run `skillwiki init`.
- Do **not** cat, echo, or print tokens or `~/.skillwiki/.env`.
- Do **not** reuse another host’s token (`msi`, `doubao-linux-agent`, `macos-dev`, …).
- Do **not** use 云盘 / Drive / CloudStorage as the secret path. Only a chat-attached file reaches the VM.
- Missing `WIKI_PATH` is expected on an MCP-only leaf. Handshake pass is done.
- Do **not** instruct the operator to paste the bearer into the chat transcript.

## Paste-once prompt

Give the unknown agent this prompt (no leading slash). After `skillwiki connect` exists, prefer `--from-file` over `cp`.

```text
You are on a SkillWiki HTTP MCP leaf. Goal: connect as a unique host-id writer. No connector is required.

Hard rules:
- Do NOT run `skillwiki init`.
- Do NOT cat/echo/print tokens or ~/.skillwiki/.env.
- Do NOT reuse another host’s token (msi, doubao-linux-agent, macos-dev, …).
- Do NOT use 云盘/Drive as the secret path. Only a chat-attached file reaches this VM.
- WIKI_PATH missing is expected. Handshake pass = done.
- Do NOT paste the bearer into chat.

Do this:
1) If a SkillWiki connector exists and is NOT “local-only”, use it and stop.
2) Else install/upgrade `skillwiki` CLI if missing.
3) mkdir -p ~/.skillwiki
4) If ~/.skillwiki/.env has a non-empty SKILLWIKI_MCP_TOKEN:
   skillwiki doctor --check-mcp
5) If token is empty: STOP. Ask the operator to attach a mode-600 env file as a CHAT ATTACHMENT (not Drive). Then:
   skillwiki connect --from-file <attachment>
   delete the sandbox copy if you can (do not cat it)
   skillwiki doctor --check-mcp
6) Report only: writer_id, ok, auth, reconcile_ready, TOKEN_SET|EMPTY.
7) Then wiki_query one tiny smoke. Stop. Never print secrets.
```

Operator metal side stays: `skillwiki mcp-auth issue-host --host-id <new-id> --write`, then attach the env file. Do not mint from this skill.

## CLI

Always no-init.

```text
skillwiki connect --from-file <chat-attachment>
skillwiki connect --from-file <chat-attachment> --dry-run
skillwiki connect --from-stdin --dry-run
```

`--from-file` and `--from-stdin` are mutually exclusive. `--force` overwrites a different existing token. Cloud Drive paths are refused. Reserved host-ids are refused unless `--force`. Write mode is `0600`.

Doctor on an MCP-only leaf (no vault + token present + vault-sync not installed) treats missing `WIKI_PATH` as info, not an init cluster.

## Stop conditions

- A non-local-only SkillWiki connector already authenticates.
- `skillwiki connect` or doctor `--check-mcp` reports `TOKEN_SET` / auth present and handshake `ok`.
- The operator has not attached an env file and no token exists — stop and ask for a chat attachment, never for a paste into chat.
---
