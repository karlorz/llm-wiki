# Agent Memory Trends

Private `llm-wiki` workspace package for the nightly agent-memory research workflow. It is intentionally not part of the public plugin install path in v1.

The package stages high-signal agent-memory research into the vault. It collects bounded GitHub candidates through `gh api`, prepares a Codex synthesis input, runs a non-interactive Codex job, validates generated vault output through the publisher gate, pushes successful changes, and sends a heartbeat only after the push succeeds.

## Codex Invocation

The runner is tested against `codex-cli 0.139.0`, where live search and approval
policy are top-level Codex flags. Keep them before the `exec` subcommand:

```bash
codex --search --ask-for-approval never exec \
  --sandbox workspace-write \
  --cd "$AGENT_MEMORY_TRENDS_VAULT" \
  --add-dir "$AGENT_MEMORY_TRENDS_REPO" \
  --add-dir "$TMPDIR" \
  --output-last-message "$LAST_MESSAGE_PATH" \
  -
```

Do not use `codex exec --search ...` with this CLI generation; it is rejected
before the job starts.

## Runtime Host

The nightly writer runs on `sg02` as the dedicated non-root Unix user `agent-memory`. Do not run the writer on `sg01`; `sg01` remains protected snapshotter infrastructure.

Tracked rollout files:

- `service-units/systemd/agent-memory-trends.service`
- `service-units/systemd/agent-memory-trends.timer`
- `scripts/install-sg02.sh`

The systemd service is a system-level unit under `/etc/systemd/system`, runs with `User=agent-memory`, reads `/home/agent-memory/.config/agent-memory-trends/env`, and executes `/home/agent-memory/.local/bin/agent-memory-trends-daily`.

The timer runs daily at `00:10` Asia/Hong_Kong with `RandomizedDelaySec=300`, `Persistent=true`, and `AccuracySec=60s`.

## Install on sg02

From a checked-out `llm-wiki` repo on `sg02`:

```bash
sudo bash packages/agent-memory-trends/scripts/install-sg02.sh
```

The installer creates the `agent-memory` user when missing, prepares directories, writes `/home/agent-memory/.config/agent-memory-trends/env.example`, creates `/home/agent-memory/.config/agent-memory-trends/env` if absent, installs the wrapper, copies the service and timer units, and runs `systemctl daemon-reload`.

By default it stops before manual auth gates and does not enable the timer. Use `--enable` only after the manual gates and a manual live run pass:

```bash
sudo bash packages/agent-memory-trends/scripts/install-sg02.sh --enable
```

## Manual Gates

Run these as the `agent-memory` user unless the command explicitly needs `sudo`.

```bash
gh auth login
```

Verify Git SSH push from the vault checkout. The job commits and pushes generated vault output to `origin main`; no force push is used.

```bash
ssh -T git@github.com
git -C /home/agent-memory/wiki fetch origin main
```

Authenticate Codex and confirm the non-interactive runner is healthy.

```bash
codex login
codex doctor
```

Configure the heartbeat only in the untracked service env file. Do not put secrets in tracked files.

```bash
sudo -u agent-memory editor /home/agent-memory/.config/agent-memory-trends/env
```

Expected private setting:

```bash
AGENT_MEMORY_TRENDS_HEARTBEAT_URL=https://...
```

Run local package checks before enabling the service path.

```bash
npm run -w @skillwiki/agent-memory-trends test
npm run -w @skillwiki/agent-memory-trends typecheck
npm run -w @skillwiki/agent-memory-trends build
rm -rf packages/agent-memory-trends/dist
```

Run dry-run checks. Dry-run mode must not commit, push, or heartbeat.

```bash
agent-memory-trends doctor
agent-memory-trends collect --dry-run
agent-memory-trends daily --dry-run
```

Run one manual live service start before enabling the timer.

```bash
sudo systemctl start agent-memory-trends.service
journalctl -u agent-memory-trends.service --no-pager -n 200
```

After the manual live run verifies the GitHub commit, `meta/latest-session-brief.md`, digest, evidence, task captures if any, run JSON, and Uptime Kuma heartbeat, enable the timer.

```bash
sudo systemctl enable --now agent-memory-trends.timer
```

## Safety Contract

The workflow must preserve these constraints:

- `packages/agent-memory-trends` remains private.
- `gh auth login` and `codex login` store credentials in each tool's normal user state; do not copy tokens into tracked config.
- `AGENT_MEMORY_TRENDS_HEARTBEAT_URL` belongs only in `/home/agent-memory/.config/agent-memory-trends/env`.
- Publisher validation must reject out-of-allowlist changes, raw rewrites, symlinks, executable generated files, oversized files, secret-like content, manifest mismatches, too many task captures, and too many web sources.
- The heartbeat fires only after a successful push.
- `sg01` is read-only for this workflow.
