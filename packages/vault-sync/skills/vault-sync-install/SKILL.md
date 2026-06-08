---
name: vault-sync-install
description: Install vault-sync on the current host. Detects OS, deploys scripts, registers scheduler jobs, and supports a Linux FUSE-only mode for rclone-mounted wiki consumers.
argument-hint: "[--mode=full|fuse-only] [--role=leaf|snapshotter] [--service-scope=user|system] [--vault-path=<path>] [--dry-run] [--override-snapshotter]"
---

# vault-sync-install

Install vault-sync on the current host. OS-detecting, idempotent installer that deploys scripts, installs scheduler units, and registers with skillwiki config.

## When to use

- First-time setup of vault-sync on a new host
- Upgrading vault-sync scripts after a plugin update
- Switching a host from leaf to snapshotter role (requires `--override-snapshotter`)
- Installing only the Linux rclone FUSE refresh timer on an LXC/S3-mounted wiki consumer

## Steps

1. **Detect OS** — run `platform_detect_os`. Fail on `unsupported`.
2. **Parse flags**:
   - `--mode=full|fuse-only` (default: `full`).
   - `--role=leaf|snapshotter` (default: `leaf`). If `snapshotter`:
     - Read `fleet.yaml` from vault via `fleet_load`.
     - Call `fleet_validate_install $(hostname) snapshotter [--override-snapshotter]`.
     - On override: print warning, note that fleet.yaml update is deferred to user.
   - `--service-scope=auto|user|system` for Linux FUSE-only installs. `auto` uses `system` when run as root and `user` otherwise.
   - `--vault-path=<path>` for the FUSE-only mount guard. Defaults to `~/wiki`.
   - `--max-dir-cache=<duration>` for the FUSE freshness envelope. Defaults to `15m`.
3. **Check prerequisites**:
   - `command -v rclone` — required. Warn-only if not found, but install proceeds (rclone can be installed later).
   - `command -v git` — required for `--mode=full`. Fail if missing.
   - macOS: `command -v launchctl` — required.
   - Linux full mode: `systemctl --user` must be available. Fail with hint if not.
   - Linux FUSE-only mode: `systemctl` must be available. User scope requires `systemctl --user`; system scope writes root units under `/etc/systemd/system`.
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
   - Linux: render `.service` + `.timer` with `@SCRIPT_DIR@` → `$(platform_share_dir)/bin`. Write to `~/.config/systemd/user/`. Run `systemctl --user daemon-reload && systemctl --user enable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer`.
   - Linux post-check: run `wiki-fuse-refresh.sh --check-only --max-dir-cache 15m` and surface a warning if the active mount exceeds the freshness envelope.
   - Linux only: `loginctl enable-linger $USER`. If this fails, surface as a hard error — without it, headless LXC will silently not sync.
7. **Register in skillwiki config** for full mode:
   ```
   skillwiki config set vault_sync.installed true
   skillwiki config set vault_sync.role <role>
   skillwiki config set vault_sync.scheduler <launchd|systemd>
   skillwiki config set vault_sync.fuse_refresh_enabled <true|false>
   skillwiki config set vault_sync.fuse_refresh_interval 300s   # Linux only
   skillwiki config set vault_sync.fuse_max_dir_cache 15m       # Linux only
   ```
8. **`--dry-run` mode**: print the entire plan (paths, commands, fleet.yaml diff) but execute nothing.

## FUSE-Only Mode

Use `--mode=fuse-only` for Linux hosts where the wiki path is an rclone S3 FUSE mount and not a git-backed vault. This mode is intended for pvelxc/LXC consumers like `/root/wiki -> wiki-s3:cloud/wiki`.

FUSE-only mode:

- Requires Linux and verifies `findmnt -T <vault-path>` reports `fuse.rclone`.
- In execute mode, requires an active `rclone mount` process and validates the helper dry-run before completing.
- Copies only `wiki-fuse-refresh.sh` and `scripts/lib/`.
- Installs only `wiki-fuse-refresh.service` and `wiki-fuse-refresh.timer`.
- Supports user systemd units under `~/.config/systemd/user` and root/system units under `/etc/systemd/system`.
- Sets `HOME` in the systemd service so logs land under `$(platform_log_dir)`.
- Sets `vault_sync.fuse_refresh_enabled=true`, `vault_sync.fuse_refresh_interval=300s`, and `vault_sync.fuse_max_dir_cache=<duration>`.
- Does **not** install or enable `wiki-push` or `wiki-fetch`.
- Does **not** mark `vault_sync.installed=true`; that key is reserved for the full role workflow.

Do not use FUSE-only mode on a normal git-backed wiki vault.

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
bash packages/vault-sync/skills/vault-sync-install/install.sh --mode fuse-only --vault-path /root/wiki --service-scope system --dry-run

# Companion script (headless / CI)
VS_ROLE=leaf VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
VS_MODE=fuse-only VS_VAULT_PATH=/root/wiki VS_SERVICE_SCOPE=system VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
```
