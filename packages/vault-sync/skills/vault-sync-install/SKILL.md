---
name: vault-sync-install
description: Install vault-sync on the current host. Detects OS, deploys scripts, registers scheduler jobs, and supports a Linux FUSE-only mode for rclone-mounted wiki consumers. Use when asked to install vault-sync, reinstall after plugin update, rsync/staged deploy with runtime-manifest provenance (VS_PACKAGE_VERSION / VS_PACKAGE_COMMIT), or switch leaf vs snapshotter roles.
argument-hint: "[--mode=full|fuse-only] [--role=leaf|snapshotter] [--service-scope=user|system] [--vault-path=<path>] [--package-version=<ver>] [--package-commit=<sha>] [--dry-run] [--override-snapshotter]"
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
   - `--service-scope=auto|user|system` for Linux snapshotter or FUSE-only installs. `auto` uses `system` when run as root and `user` otherwise. Full leaf installs stay on user units.
   - `--vault-path=<path>` for the FUSE-only mount guard. Defaults to `~/wiki`.
   - `--max-dir-cache=<duration>` for the FUSE freshness envelope. Defaults to `15m`.
   - `--package-version=<ver>` / `--package-commit=<sha>` (optional) — set deploy provenance for `runtime-manifest.json`. Equivalent env: `VS_PACKAGE_VERSION`, `VS_PACKAGE_COMMIT`. Metadata only; does not change copied scripts. Required for honest manifests when the package root is rsynced without monorepo `package.json` / git.
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
   cp packages/vault-sync/skills/vault-presync/wiki-sync.sh $(platform_share_dir)/bin/wiki-sync.sh
   chmod +x $(platform_share_dir)/bin/*.sh
   ```
   For full installs, also create or repair `~/bin/wiki-sync.sh` as a symlink
   to `$(platform_share_dir)/bin/wiki-sync.sh` when safe. Do not clobber a real
   non-symlink user file at that path.
5. **Deploy filter file**:
   ```
   mkdir -p $(platform_rclone_config_dir)
   cp packages/vault-sync/filters/wiki-push-filters.txt $(platform_rclone_config_dir)/
   ```
6. **Install scheduler units**:
   - macOS: render `.plist.tmpl` files with `@SCRIPT_DIR@` → `$(platform_share_dir)/bin`, `@LOG_DIR@` → `$(platform_log_dir)`. Write to `~/Library/LaunchAgents/`. Run `launchctl bootstrap gui/$UID <plist>`.
   - Linux leaf: render `.service` + `.timer` with `@SCRIPT_DIR@` → `$(platform_share_dir)/bin`. Write to `~/.config/systemd/user/`. Run `systemctl --user daemon-reload && systemctl --user enable --now wiki-push.timer wiki-fetch.timer wiki-fuse-refresh.timer`.
   - Linux snapshotter: render `wiki-snapshot.service` + `wiki-snapshot.timer` plus `wiki-fuse-refresh.service` + `wiki-fuse-refresh.timer`. Write to `/etc/systemd/system/` for `--service-scope system` or `~/.config/systemd/user/` for `--service-scope user`. Enable `wiki-snapshot.timer` on a 30-minute cadence (`*:02` and `*:32`) plus the 5-minute FUSE refresh timer.
   - Linux post-check: run `wiki-fuse-refresh.sh --check-only --max-dir-cache 15m` and surface a warning if the active mount exceeds the freshness envelope.
   - Linux only: `loginctl enable-linger $USER`. If this fails, surface as a hard error — without it, headless LXC will silently not sync.
7. **Register in skillwiki config** for full mode:
   ```
   skillwiki config set vault_sync.installed true
   skillwiki config set vault_sync.role <role>
   skillwiki config set vault_sync.scheduler <launchd|systemd>
   skillwiki config set vault_sync.service_scope <user|system>   # Linux only
   skillwiki config set vault_sync.fuse_refresh_enabled <true|false>
   skillwiki config set vault_sync.fuse_refresh_interval 300s   # Linux only
   skillwiki config set vault_sync.fuse_max_dir_cache 15m       # Linux only
   ```
   Snapshotter installs also record `vault_sync.snapshot_script` and the conventional profile path `vault_sync.snapshot_profile=/etc/vault-sync/profiles/<host>-snapshotter.env`.
   The snapshotter profile is the operational authority for its host-local
   rclone alias and should contain `CLOUD_REMOTE=<remote:path>`. Managed leaf
   hosts should set `WIKI_REMOTE=<remote:path>` in `~/.skillwiki/.env`. Rclone
   remote names are local aliases and may legitimately differ between hosts.
   Status treats a missing remote as unconfigured/unknown; it must not probe a
   guessed alias and report a false outage.
8. **Write runtime inventory** for successful non-dry-run full installs: `$(platform_share_dir)/runtime-manifest.json` (package/installer version, host role, SHA-256 hashes of installed scripts and LaunchAgents plists).
9. **`--dry-run` mode**: print the entire plan (paths, commands, fleet.yaml diff) but execute nothing.

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

On macOS, launchd install is an **observed-state** transaction:

1. Domain probe (`launchctl print`)
2. Bootout until the label is absent
3. Enable
4. Bootstrap

EIO from `launchctl` is **not special** — it is reconciled only when `launchctl print` shows the label present (exit status only; no field parsing of launchctl output). Candidate plists are staged and moved into place only after registration is proven absent.

Rollback copies live under `$(platform_cache_dir)/install-rollback/<timestamp>/` and are **retained after success** until a later status/live-verify step clears them. Do not delete rollback dirs merely because bootstrap returned success.

After a successful non-dry-run install, `$(platform_share_dir)/runtime-manifest.json` records package/installer version, host role, and SHA-256 hashes of installed scripts and LaunchAgents plists.

Typical share / cache / log roots:

| OS | `platform_share_dir` | `platform_cache_dir` | `platform_log_dir` |
|----|----------------------|----------------------|--------------------|
| macOS | `~/Library/Application Support/vault-sync` | `~/Library/Caches/vault-sync` | `~/Library/Logs` |
| Linux | `~/.local/share/vault-sync` | `~/.cache/vault-sync` | `~/.local/state/vault-sync/log` |

Pull log path for live verification: `$(platform_log_dir)/wiki-pull.log` (macOS: `~/Library/Logs/wiki-pull.log`).

## Attended verification checklist (rollout proof)

Repository tests green ≠ install work complete. After deploying to a real host, run this attended checklist before treating the install as done:

1. From package source (not only a packaged tarball), reinstall leaf role:
   ```bash
   bash packages/vault-sync/skills/vault-sync-install/install.sh --role leaf --execute
   ```
2. Prove runtime hashes match package sources:
   ```bash
   bash packages/vault-sync/skills/vault-sync-status/status.sh --read-only
   ```
   Expect `vault_sync_runtime_match=pass` (and a parseable `runtime-manifest.json`).
3. Wait for a scheduled `wiki-fetch` cycle, or kickstart it / run the pull helper once so a live pull executes on the installed scripts.
4. Confirm the pull log shows helper-owned journal lines (`op=…`) and **no** legacy `wiki-pull auto-stash` messages:
   ```bash
   # macOS
   grep -E 'op=|auto-stash' "$HOME/Library/Logs/wiki-pull.log"
   # Linux
   # grep -E 'op=|auto-stash' "$HOME/.local/state/vault-sync/log/wiki-pull.log"
   ```
5. Touch the live-verify marker **only after step 4** succeeds:
   ```bash
   # Exact path: $(platform_share_dir)/live-verify.ok
   # macOS:  ~/Library/Application Support/vault-sync/live-verify.ok
   # Linux:  ~/.local/share/vault-sync/live-verify.ok
   touch "$HOME/Library/Application Support/vault-sync/live-verify.ok"   # macOS
   # touch "$HOME/.local/share/vault-sync/live-verify.ok"               # Linux
   ```
   Status reports `vault_sync_live_verify=pass` only when this marker exists. Status never writes the marker itself.

## Completion gate

- Green `npm run test:vault-sync` (or CI) is **necessary but not sufficient**.
- Update the vault work item `status: completed` **only** after live scheduled-cycle evidence is recorded in the work retro (attended checklist above, including `live-verify.ok`).
- Do not mark the work item completed from repository tests alone.

## Guardrails

- **sg01 is production.** Never run this skill with `--execute` on sg01 from CI. Only hand-migration with human supervision.
- **Single-writer-git.** Only one host per fleet may be snapshotter. Fleet validation enforces this.
- **Protected hosts.** If the host is marked `protected: true` in fleet.yaml, the install proceeds (installing is non-destructive) but prints a warning.

## Package root (monorepo vs plugin)

Resolve the vault-sync package root before invoking the companion script:

1. **Monorepo checkout:** `<repo>/packages/vault-sync`
2. **Claude / Codex plugin install:** directory that contains `skills/vault-sync-install` (plugin cache)
3. **Installed share** (`~/Library/Application Support/vault-sync` or `~/.local/share/vault-sync`) is runtime only — not package source for drift checks

```bash
# monorepo
bash packages/vault-sync/skills/vault-sync-install/install.sh --role leaf --dry-run
# plugin root (cwd = vault-sync plugin package)
bash skills/vault-sync-install/install.sh --role leaf --dry-run
```

Staged / rsync install (honest runtime-manifest without monorepo git tree):

```bash
VS_PACKAGE_VERSION=0.9.60 \
VS_PACKAGE_COMMIT=<source-git-sha> \
bash skills/vault-sync-install/install.sh --role snapshotter --service-scope system --execute
# or flags (same env SSOT):
# bash skills/vault-sync-install/install.sh --package-version 0.9.60 --package-commit <sha> ...
```

See `docs/offline-host-runbook.md` for the full staged-deploy matrix and satellite-only host notes.

## Execution

```bash
# Companion script (interactive)
bash packages/vault-sync/skills/vault-sync-install/install.sh --role leaf --dry-run
bash packages/vault-sync/skills/vault-sync-install/install.sh --role snapshotter --service-scope system --dry-run
bash packages/vault-sync/skills/vault-sync-install/install.sh --mode fuse-only --vault-path /root/wiki --service-scope system --dry-run

# Companion script (headless / CI)
VS_ROLE=leaf VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
VS_ROLE=snapshotter VS_SERVICE_SCOPE=system VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
VS_MODE=fuse-only VS_VAULT_PATH=/root/wiki VS_SERVICE_SCOPE=system VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
VS_PACKAGE_VERSION=0.9.60 VS_PACKAGE_COMMIT=<sha> VS_ROLE=snapshotter VS_SERVICE_SCOPE=system VS_DRY_RUN=1 bash packages/vault-sync/skills/vault-sync-install/install.sh
```
