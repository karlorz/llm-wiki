# Credential rotation & launchd/systemd env sanitization runbook

**Operational security runbook (A3).** Attended only. Product guardrails that
prevent re-introduction live in code; this runbook covers the human procedure.

> **Never paste secret values into chat, wiki, CI logs, or work-item evidence.**
> Record names, classes, timestamps, and exit codes only.

## Why this exists

A previously observed launchd-inherited credential (macOS leaf host) showed
that service environments can leak secrets into agent/tool output. `launchctl
print` dumps the full `environment` block of a service; `systemctl show`
without `--property=` filters does the same on Linux. Health tooling must
never capture or emit those blocks.

Product guardrail (shipped A3): doctor's `vault_sync_jobs_enabled` check runs
`launchctl print gui/<uid>/com.karlchow.wiki-push` with **stdout discarded**
(`stdio: ["pipe", "ignore", "ignore"]`) - only exit status is used. All
`systemctl show` call sites already use `--property=<name> --value` filters
from the A2 property catalog.

## Secret classes (names only, never values)

The vault-sync surface can touch these secret classes:

| Class | Where it lives (intended store) | Never in |
|---|---|---|
| S3 / cloud access key + secret | snapshot profile `.env` (mode 600), OS keychain, or 1Password | wiki, repo, doctor output |
| GitHub PAT / deploy key | OS keychain, 1Password, or `git credential` helper | `.env`, wiki, service env |
| rclone remote password | rclone config (mode 600) or `rclone obscure` | wiki, doctor output |
| Snapshot profile secrets | profile `.env` at `/etc/vault-sync/profiles/*.env` | wiki, repo |

## Inheritance vectors to inventory (names only)

When checking a host, inventory **paths and unit/plist names only** - never
cat the files into a transcript.

### macOS (launchd)
- `~/Library/LaunchAgents/com.karlchow.wiki-push.plist` - check for
  `EnvironmentVariables` dict (names only).
- `/Library/LaunchDaemons/` - any vault-sync daemon.
- Interactive shell profile leakage: `~/.zshrc`, `~/.bashrc`, `~/.profile`
  exporting secrets that agents inherit at bootstrap.

### Linux (systemd)
- `systemctl cat wiki-push.service wiki-push.timer` - check for `Environment=`
  and `EnvironmentFile=` lines (names only).
- `/etc/systemd/system/wiki-push*.service` drop-ins.
- `/etc/vault-sync/profiles/*.env` - mode 600, owned by root.

## Rotation procedure (attended)

1. **Identify** the secret class(es) that may have been exposed, from known
   install docs - not from dumping env.
2. **Rotate** each class at its authority:
   - S3/cloud keys -> IAM console: create new key, keep old valid during
     cutover.
   - GitHub PAT -> GitHub settings: create new token, keep old valid briefly.
   - rclone remote -> `rclone config reconnect` with new credentials.
3. **Update intended stores only**: OS keychain, 1Password, or the dedicated
   profile `.env` (mode 600). Never write secret values to the wiki or repo.
4. **Remove stale values** from plist/unit drop-ins:
   - macOS: edit the plist to remove `EnvironmentVariables` entries pointing
     at rotated secrets; `launchctl unload` + `launchctl load` to reload.
   - Linux: edit the unit drop-in or `EnvironmentFile=`; `systemctl daemon-reload`
     + `systemctl restart wiki-push.timer`.
5. **Verify** (record command + exit code only, not output):
   - `skillwiki doctor` - exit 0 or expected warn count.
   - `bash packages/vault-sync/skills/vault-sync-status/status.sh --read-only`
     - exit 0.
   - Backend auth check (e.g. `rclone lsd <remote>:` or `git ls-remote`)
     succeeds.
6. **Revoke** the old secret at the authority after the cutover window
   confirms the new one works. Do not leave dual-valid keys.
7. **Confirm no secret material in evidence**: any journal snippet or log
   excerpt captured for evidence must be redacted. Use `sed` to scrub
   `AKIA...`, `ghp_...`, `-----BEGIN ... PRIVATE KEY-----` patterns before
   saving.

## Evidence template (safe to commit - no secrets)

```markdown
## Rotation evidence (no secrets)
- date: 2026-MM-DD
- host: <hostname>
- operator: <name>
- secret classes rotated: [e.g. "S3 access key", "GitHub PAT"]
- inheritance vectors cleaned: [plist/unit path NAMES only, e.g. "~/Library/LaunchAgents/com.karlchow.wiki-push.plist"]
- post-check: doctor exit 0; status.sh --read-only exit 0
- vault paths updated: none containing secret values
- old secret revoked at authority: yes | no (cutover window open until <date>)
```

## Product guardrails (enforced in code)

- `launchctl print` in doctor: stdout discarded, exit-status only (A3).
- `systemctl show` in doctor + status.sh: always `--property=<name> --value`
  from the A2 property catalog - never unfiltered.
- `launchctl print` in install.sh + platform.sh: already exit-status only
  (redirected to `/dev/null`).
- Regression test: `doctor-launchctl-env-guard.test.ts` asserts doctor output
  never contains `Environment=` / `EnvironmentVariables` / key patterns.

## Out of scope

- Automated rotation bots.
- Changing S3/GitHub authority topology.
- Full host security audit beyond vault-sync service env.
- Storing secret values in the vault (never).
