---
name: vault-sync-uninstall
description: Remove vault-sync from current host. Stops scheduler jobs, leaves tombstone markdown, preserves logs.
argument-hint: "[--keep-logs] [--purge] [--force-protected] [--reason=<text>] [--dry-run]"
---

# vault-sync-uninstall

Remove vault-sync from the current host. Stops scheduler jobs, removes deployed scripts and units, leaves tombstone markers for forensic traceability.

## When to use

- Decommissioning vault-sync on a host
- Clean reinstall (uninstall then install)
- Removing a test installation

## Steps

1. **Check installed state** — `skillwiki config get vault_sync.installed`. If false: exit 0 with message.
2. **Stop + remove scheduler units**:
   - macOS: `launchctl bootout gui/$UID/<label>` then `rm ~/Library/LaunchAgents/com.karlchow.wiki-*.plist`.
   - Linux: `systemctl --user disable --now wiki-push.timer wiki-fetch.timer` then remove unit files.
3. **Create tombstone** `*.RETIRED.md` next to each removed unit (ADR D7 pattern):
   ```markdown
   # RETIRED — com.karlchow.wiki-push
   - Retired: <ISO date>
   - Why: <reason from --reason flag, or "manual uninstall">
   - Restore: claude plugin install vault-sync@llm-wiki && /vault-sync-install
   ```
4. **Remove scripts**:
   ```
   rm -rf $(platform_share_dir)/bin
   ```
5. **Unregister from skillwiki config**:
   ```
   skillwiki config set vault_sync.installed false
   ```
6. **`--keep-logs`** (default): preserve `wiki-*.log`. **`--purge`**: also remove logs.
7. **Refuse to run on a host** where `fleet.yaml` marks it as `protected: true`. Override: `--force-protected` (sg01 hand-migration scenario only).

## Guardrails

- **Protected hosts** (e.g., sg01) are refused by default. `--force-protected` is required for hand-migration.
- **Tombstones** are always left (never purged) — they are forensic breadcrumbs for future debugging.
- **Logs are preserved** by default — they contain debugging information.

## Execution

```bash
# Companion script (interactive)
bash packages/vault-sync/skills/vault-sync-uninstall/uninstall.sh --dry-run
bash packages/vault-sync/skills/vault-sync-uninstall/uninstall.sh --purge
bash packages/vault-sync/skills/vault-sync-uninstall/uninstall.sh --force-protected --reason \"manual host migration\"

# Companion script (headless / CI)
VS_DRY_RUN=1 VS_PURGE=0 bash packages/vault-sync/skills/vault-sync-uninstall/uninstall.sh
```
