# Grok Bot task: finance-digest shadow (wiki-fin)

Do not start this prompt with a slash command.

This is the Slice 6 generate-only / shadow routine. Hermes `finance-digest` on sg02 stays running until an attended cutover. Never dual-write a canonical path with Hermes. Never park output in central as `projects/finance/`.

## Configure (same connector)

- Connector URL: `https://wiki.karldigi.dev/mcp` (one connector; no second MCP URL)
- Secret: existing `SKILLWIKI_MCP_TOKEN` field only after the coordinator issues a finance-writer principal
- Non-secret opt-in: `SKILLWIKI_EXTRA_VAULTS=wiki-fin`
- Routine required vaults: `required_vaults: [wiki-fin]`
- Schedule equivalent: even hour, timezone `Asia/Hong_Kong` (UTC+8), cron `0 0,2,4,6,8,10,12,14,16,18,20,22 * * *`
- Enabled: **no** until the coordinator approves a shadow schedule. Keep this definition disabled.

## Every run (shadow)

1. Fail closed unless handshake `allowed_vaults` includes `wiki-fin` *and* local `SKILLWIKI_EXTRA_VAULTS` includes `wiki-fin`. Do not treat client opt-in as authorization.
2. Run `scripts/wiki-fin/collect-dry-run.sh` from the llm-wiki checkout (fixture by default; live RSS only when `FINANCE_DIGEST_FIXTURE=` is explicitly emptied).
3. Read the printed `out_dir` / `summary.json` / `mcp-path-plan.json`. Compare path intent to the legacy Hermes contract: collect RSS → typed pages + log, Telegram zh-Hant later.
4. Do **not** call `wiki_capture`, `wiki_page_publish`, `wiki_workitem_write`, or `wiki_log_append`.
5. Do **not** write `/root/wiki-fin`, `~/wiki`, or `/opt/skillwiki-mcp/vault`.
6. Do **not** `git commit` / `git push` wiki-fin.
7. Do **not** Telegram-deliver.
8. Report artifact paths and headline counts only.

## Later gates (not this dispatch)

- Slice 6b: attended MCP dry-run in `wiki-fin` after 6a provision is approved.
- Three consecutive generate-only runs with operator-reviewed parity before any canonical write.
- Slice 6d/6e: suspend Hermes, one attended canonical MCP publish, then deprecation — only if the coordinator says shadow already passed.
