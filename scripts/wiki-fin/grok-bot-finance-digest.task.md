# Grok Bot task: finance-digest shadow (wiki-fin)

Do not start this prompt with a slash command.

This is the Slice 6 **generate-only / shadow** routine for a **Grok Bot** (not this Grok TUI, not Hermes). Hermes `finance-digest` job `997ba0d66623` on sg02 stays scheduled until an attended 6d pause. Never dual-write a canonical path. Never park output in central as `projects/finance/`.

Coordinator 2026-09-18: Track A forgot the live Bot. This file is the paste card. Create the Bot in Grok Bot UI; this repo cannot mint that Bot from the TUI.

## Create the Bot (once)

1. In Grok Bot: **New → Create new Bot**. Name: `finance-digest-wiki-fin`. Job: even-hour generate-only finance digest against extra vault `wiki-fin`.
2. **Plugins → Configure** on that Bot only (same connector URL `https://wiki.karldigi.dev/mcp`):
   - `SKILLWIKI_MCP_TOKEN` = metal-issued `grok-bot-wiki-fin` bearer (never macos-dev; never paste into this repo or wiki).
   - `SKILLWIKI_EXTRA_VAULTS` = `wiki-fin` (non-secret).
3. Confirm handshake `allowed_vaults` includes `wiki-fin` and `default_vault` is not used for digest writes.
4. Paste the routine text below. Schedule: timezone `Asia/Hong_Kong`, even hour, cron `0 0,2,4,6,8,10,12,14,16,18,20,22 * * *` (or Bot equivalent “every 2 hours from :00”).
5. **First run: Run now** once in shadow mode. If it tries `wiki_capture` / Telegram / central paths, pause the routine.
6. Keep the routine **enabled for shadow only**. Canonical MCP publish is Slice 6d after Karl says `pause_now`.

## Routine text (paste)

You own the even-hour finance-digest **shadow**. Hermes on sg02 is still the live writer.

Fail closed unless SkillWiki HTTP MCP handshake `allowed_vaults` includes `wiki-fin` and Configure `SKILLWIKI_EXTRA_VAULTS` includes `wiki-fin`. Client opt-in is not authorization.

Run generate-only collection only:
- Prefer `scripts/wiki-fin/collect-dry-run.sh` from the llm-wiki checkout when that path exists.
- Default fixture headlines. Live RSS only if `FINANCE_DIGEST_FIXTURE` is explicitly emptied by the operator.
- Read `summary.json` and `mcp-path-plan.json`. Compare path intent to the Hermes contract: RSS → typed pages + log; Telegram zh-Hant later.

Do **not**:
- call `wiki_capture`, `wiki_page_publish`, `wiki_workitem_write`, or `wiki_log_append`
- write `/root/wiki-fin`, `~/wiki`, `/opt/skillwiki-mcp/vault`, or `cloud/wiki`
- git commit / git push
- Telegram-deliver
- pause or delete Hermes
- use `vault=` omitted (that is central)

Report artifact paths and headline counts only.

## Gates

- 6a prefix + 6b MCP dry-run: already done on sg01 (`cloud/wiki-fin`).
- 6c: three local fixture shadows already ran `canonical_write=false`. Live Bot shadows are the next parity evidence.
- 6d/6e: not this routine. Coordinator must reply `pause_now` before Hermes is suspended.
