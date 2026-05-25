---
name: vault-sync-install
description: Install vault-sync on the current host. Detects OS, deploys scripts, registers scheduler jobs (launchd or systemd-user), runs loginctl enable-linger on Linux. Idempotent.
argument-hint: "[--role=leaf|snapshotter] [--dry-run] [--override-snapshotter]"
---

# vault-sync-install

Install vault-sync on the current host. OS-detecting, idempotent installer that deploys scripts, installs scheduler units, and registers with skillwiki config.

## When to use

- First-time setup of vault-sync on a new host
- Upgrading vault-sync scripts after a plugin update
- Switching a host from leaf to snapshotter role (requires `--override-snapshotter`)

## Steps

1. **Detect OS** — run `platform_detect_os`. Fail on `unsupported`.
2. **Parse flags**:
   - `--role=leaf|snapshotter` (default: `leaf`). If `snapshotter`:
     - Read `fleet.yaml` from vault via `fleet_load`.
     - Call `fleet_validate_install $(hostname) snapshotter [--override-snapshotter]`.
     - On override: print warning, note that fleet.yaml update is deferred to user.
3. **Check prerequisites**:
   - `command -v rclone` — required. Warn-only if not found, but install proceeds (rclone can be installed later).
   - `command -v git` — required. Fail if missing.
   - macOS: `command -v launchctl` — required.
   - Linux: `systemctl --user` must be available. Fail with hint if not.
4. **Deploy scripts**:
   ```
   mkdir -p $(platform_share_dir)/bin
   cp packages/vault-sync/scripts/*.sh $(platform_share_dir)/bin/
   cp -r packages/vault-sync/scripts/lib $(platform_share_dir)/bin/
   chmod +x $(platform_share_dir)/bin/*.sh
   ```
5. **Deploy filter file**:
   ```
   mkdir -p $(platform_rclone_config_dir)
   cp packages/vault-sync/filters/wiki-push-filters.txt $(platform_rclone_config_dir)/
   ```
6. **Install scheduler units**:
   - macOS: render `.plist.tmpl` files with `@SCRIPT_DIR@` → `$(platform_share_dir)/bin`, `@LOG_DIR@` → `$(platform_log_dir)`. Write to `~/Library/LaunchAgents/`. Run `launchctl bootstrap gui/$UID <plist>`.
   - Linux: render `.service` + `.timer` with `@SCRIPT_DIR@` → `$(platform_share_dir)/bin`. Write to `~/.config/systemd/user/`. Run `systemctl --user daemon-reload && systemctl --user enable --now wiki-push.timer wiki-fetch.timer`.
   - Linux only: `loginctl enable-linger $USER`. If this fails, surface as a hard error — without it, headless LXC will silently not sync.
7. **Register in skillwiki config**:
   ```
   skillwiki config set vault_sync.installed true
   skillwiki config set vault_sync.role <role>
   skillwiki config set vault_sync.scheduler <launchd|systemd>
   ```
8. **`--dry-run` mode**: print the entire plan (paths, commands, fleet.yaml diff) but execute nothing.

## Idempotency

Re-running the install upgrades scripts in-place. Existing scheduler units are reloaded, not duplicated.

## Guardrails

- **sg01 is production.** Never run this skill with `--execute` on sg01 from CI. Only hand-migration with human supervision.
- **Single-writer-git.** Only one host per fleet may be snapshotter. Fleet validation enforces this.
- **Protected hosts.** If the host is marked `protected: true` in fleet.yaml, the install proceeds (installing is non-destructive) but prints a warning.

## Execution

```bash
# Companion script (interactive)
bash packages/vault-sync/skills/vault-sync-install/install.sh --role leaf --dry-run

# Companion script (headless / CI)
VS_ROLE=leaf VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
```
