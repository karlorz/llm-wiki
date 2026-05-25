# Archived workflows — 2026-05-25

## `e2e-vault-sync.yml.disabled`

**Archived:** 2026-05-25
**Reason:** Required `SSH_PRIVATE_KEY` and `SSH_PRIVATE_KEY_LXC` secrets in GitHub Actions to reach sg01/sg02/LXC hosts. Per policy, we do not expose SSH credentials to GitHub-hosted CI.

**Replacement:** The vault-sync e2e scripts are still functional and intended for **local invocation**, not GitHub Actions:

- `scripts/e2e-vault-sync-local.sh` — runs on macOS dev workstation (dry-run by default, full lifecycle with `LOCAL_LIFECYCLE=true` for fresh hosts)
- `scripts/e2e-vault-sync-remote.sh` — runs from a local trusted shell against sg02 / LXC via `HOST_ENV=scripts/hosts/<host>.env`
- sg01 read-only verify — run manually from a local shell, never from external CI

**Restore path:** If you want to re-enable later in a private runner / self-hosted environment where SSH key exposure is acceptable, move this file back to `.github/workflows/` and rename to `.yml`.

**Reference:** Work item `projects/llm-wiki/work/2026-05-25-vault-sync-plugin-scaffold/` (Item 4 closure).
