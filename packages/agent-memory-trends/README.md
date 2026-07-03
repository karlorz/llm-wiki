# Agent Memory Trends

Private `llm-wiki` workspace package for the nightly agent-memory research workflow. It is intentionally not part of the public plugin install path in v1.

The package stages high-signal agent-memory research into the vault. It collects bounded GitHub candidates through `gh api`, prepares an agent-neutral synthesis input, runs a non-interactive synthesis runner when there is a selected research signal, validates generated vault output through the publisher gate, pushes successful changes, and sends a heartbeat only after the push succeeds.

## GitHub Discovery Lanes

GitHub recall is lane-based rather than a single updated-first query list. The
owned config at
`/Users/karlchow/wiki/projects/llm-wiki/architecture/agent-memory-research-sources.yaml`
defines four lanes:

- `daily_fresh`: short pushed window, `sort=updated`, filtered by a low but real
  quality gate so minute-level 0-star noise does not flood the digest.
- `weekly_momentum`: seven-day pushed window, `sort=stars`, with stars/forks and
  evidence-family gates.
- `monthly_authority`: thirty-day pushed window, `sort=stars`, so high-authority
  active projects remain visible even when they are not the newest pushed repo.
- `emerging`: thirty-day created window, `sort=updated`, for low-authority
  projects with strong implementation evidence. These are usually inspection
  ideas, not direct implementation tasks.

Each selected candidate carries `lane_ids`, `query_ids`, `quality_gate`, and
`evidence_families`. Duplicate repositories returned by multiple lanes merge by
canonical GitHub URL before scoring, preserving all lane/query provenance.

The scorer uses five explicit components:

- `relevance` / 30
- `implementation_evidence` / 25
- `authority_momentum` / 25
- `freshness` / 10
- `novelty_or_tracking` / 10

Known repositories are not hidden at scoring time. They receive
`tracking_status: "tracked_existing"` and remain visible in selected or
duplicate-suppression payloads, while TypeScript capture rendering still
suppresses duplicate raw transcript creation.

Digest-only duplicate suppression is age-bounded. Repositories already present
in `queries/*-agent-memory-trends-digest.md` are suppressed only while the
matching digest is inside `dedupe.digest_ttl_days` from the owned research
config; the default is 14 days. Raw task captures and active work items remain
hard suppressions because they represent explicit ownership, not historical
trend coverage. For controlled real-candidate debugging, use
`--dedupe-digest-ttl-days <n>` to shorten or lengthen only the current CLI run;
do not use synthetic provider prompts.

Legacy configs with a flat `github.queries` list still parse through an explicit
`legacy_flat` compatibility lane. New owned config should use `github.lanes`.

## Synthesis Contract

`agent-memory-trends` keeps the shared synthesis boundary agent-client-neutral. The core pipeline depends on `SynthesisRunner`; Codex is the primary live adapter and Claude Code CLI is an optional fallback adapter. Both feed the same downstream publisher contract.

GitHub READMEs are fetched for deterministic scoring, but full README bodies are not sent to the agent prompt. The collector extracts bounded `readme_evidence` items with:

- `source_url`
- `excerpt`
- `supports_claim`
- `confidence`

When there is a selected research signal, the agent may write the aggregate evidence file, digest, run manifest, and conservative watchlist updates. Quiet duplicate-only runs skip synthesis and publish only agent-memory-trends run state plus heartbeat. The agent must not write `raw/transcripts` captures directly. Instead, it returns structured proposal JSON in the final message captured by `--output-last-message`.

Proposal fields are `title`, `capture_kind`, `problem`, `requirements_or_questions`, `acceptance`, `evidence`, `affected_surfaces`, and `source_urls`. `capture_kind` is limited to `task`, `bug`, or `idea`; `affected_surfaces` is a small controlled vocabulary owned by `src/synthesis.ts`.

TypeScript validates proposals all-or-zero before creating captures:

- Any malformed proposal or missing evidence suppresses all task/bug/idea captures for the run.
- Metadata-only candidates do not become executable `task` captures. They may become `idea` captures only when the acceptance is source inspection and decision.
- Post-proposal duplicates are suppressed without failing the run.
- Suppression details are recorded in the run manifest, while evidence and digest output can still publish when valid.
- Rendered captures carry `outputs.task_capture_renderer: "typescript"` in the manifest; publisher validation rejects transcript captures without that marker.
- Retry and fallback are limited to runner/output-production failures: non-zero runner exit, timeout, missing manifest, or missing last-message output. Proposal validation, capture rendering, publisher validation, vault guards, and git/publish failures remain deterministic errors and do not trigger fallback.

## Codex Invocation

The Codex adapter is tested against `codex-cli 0.142.0`, where live search and
approval policy are top-level Codex flags. Keep them before the `exec`
subcommand:

```bash
codex --search --ask-for-approval never --disable hooks exec \
  --sandbox workspace-write \
  --cd "$AGENT_MEMORY_TRENDS_VAULT" \
  --add-dir "$AGENT_MEMORY_TRENDS_REPO" \
  --add-dir "$TMPDIR" \
  --output-last-message "$LAST_MESSAGE_PATH" \
  -
```

Do not use `codex exec --search ...` with this CLI generation; it is rejected
before the job starts.

By default, synthesis retries Codex once before fallback. The subprocess
timeout defaults to 20 minutes so the systemd unit's 30 minute `RuntimeMaxSec`
still has room to record failure state. Configure these only in the service env
file or one-off CLI flags:

```bash
AGENT_MEMORY_TRENDS_SYNTHESIS_RETRIES=1
AGENT_MEMORY_TRENDS_SYNTHESIS_FALLBACK=claude  # claude or none
AGENT_MEMORY_TRENDS_SYNTHESIS_TIMEOUT_MS=1200000
```

Equivalent CLI flags are `--synthesis-retries <n>`,
`--synthesis-fallback <claude|none>`, and `--synthesis-timeout-ms <ms>`.

Claude fallback uses `claude --print --permission-mode bypassPermissions` with
the same prompt and bounded input JSON on stdin. Fallback is attempted only when
`claude` is executable on the service `PATH`; otherwise Codex retry exhaustion
returns the primary runner failure.

When synthesis is invoked, run state includes a `synthesis` telemetry block with
the selected primary backend, primary attempt count, fallback
availability/invocation, result backend, and primary/fallback error codes.
Generated/live operational manifests are stamped with the same block. Quiet
duplicate-only runs do not include it because no synthesis backend was invoked.
If all collected candidates are suppressed by fresh digest/task/work duplicate
signals, changing Codex/Claude permission flags will not exercise providers; the
collector must surface at least one non-suppressed candidate.

## Runtime Host

The nightly writer runs on `sg02` as the dedicated non-root Unix user `agent-memory`. Do not run the writer on `sg01`; `sg01` remains protected snapshotter infrastructure.

Tracked rollout files:

- `service-units/systemd/agent-memory-trends.service`
- `service-units/systemd/agent-memory-trends.timer`
- `service-units/systemd/agent-memory-session-brief-refresh.service`
- `service-units/systemd/agent-memory-session-brief-refresh.timer`
- `service-units/systemd/agent-memory-self-update.service`
- `service-units/systemd/agent-memory-self-update.timer`
- `scripts/install-sg02.sh`

The systemd service is a system-level unit under `/etc/systemd/system`, runs with `User=agent-memory`, reads `/home/agent-memory/.config/agent-memory-trends/env`, and executes `/home/agent-memory/.local/bin/agent-memory-trends-daily`. The daily wrapper calls the guarded `@skillwiki/maintenance` runner in `--mode daily`, which performs vault preflight, runs `agent-memory-trends daily --generate-only` inside the maintenance write transaction, and pushes the maintenance-owned commit to `origin/main` instead of using the legacy direct publisher path.

The daily timer runs at `00:10` Asia/Hong_Kong with `RandomizedDelaySec=300`, `Persistent=true`, and `AccuracySec=60s`. A dedicated session-brief refresh timer runs at `01:05` Asia/Hong_Kong, and the self-update timer runs every four hours at minute 20.

## Install on sg02

### Pre-flight Checklist

Before running the installer, verify these prerequisites on `sg02`:

1. Target host is `sg02` or another non-production Linux host with systemd and root access; never run this writer on `sg01`.
2. Node.js 20 or newer and npm are installed for workspace builds and wrapper execution.
3. `git`, `ssh`, and `rsync` are installed; the vault checkout can fetch and push `origin main`.
4. GitHub CLI (`gh`) is installed and can authenticate as the `agent-memory` Unix user before live runs.
5. Codex CLI is installed, logged in as `agent-memory`, and `codex doctor` passes before live runs.
6. Optional Claude Code CLI fallback is installed, logged in as `agent-memory`, and available on `PATH` when `AGENT_MEMORY_TRENDS_SYNTHESIS_FALLBACK=claude`.
7. `skillwiki` is installed from npm and its `bin/skillwiki` symlink is on the service PATH. This is load-bearing: the publisher gate shells out to `skillwiki validate`, `skillwiki lint`, and `skillwiki audit`.
8. The `llm-wiki` repo checkout and wiki vault checkout are present at the paths in `/home/agent-memory/.config/agent-memory-trends/env`.
9. Optional heartbeat configuration is ready; `AGENT_MEMORY_TRENDS_HEARTBEAT_URL` stays only in the untracked service env file.

Quick tool availability check before installing:

```bash
export PATH="$HOME/.local/npm/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
for tool in node npm git ssh rsync gh codex skillwiki systemctl; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
node --version
npm --version
codex --version
skillwiki --version
```

From a checked-out `llm-wiki` repo on `sg02`:

```bash
sudo bash packages/agent-memory-trends/scripts/install-sg02.sh
```

The installer creates the `agent-memory` user when missing, prepares directories, writes `/home/agent-memory/.config/agent-memory-trends/env.example`, creates `/home/agent-memory/.config/agent-memory-trends/env` if absent, installs the wrapper, copies the service and timer units, and runs `systemctl daemon-reload`.

By default it stops before manual auth gates and does not enable the timers. Use `--enable` only after the manual gates and a manual live run pass:

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

Do not run synthetic provider probes such as prompts that ask Codex or Claude
to return a fixed `CODEX_OK` or `CLAUDE_OK` string. `codex doctor` is the setup
and auth gate only. Provider execution health is read from real
agent-memory-trends workload telemetry: `agent-memory-trends doctor` reports the
`synthesis_last_real_run` check from `.skillwiki/agent-memory-trends/latest-run.json`.
If the latest run was quiet and did not invoke synthesis, record it as "not
exercised by the latest real run" instead of sending an artificial model prompt.

The nightly runner uses a self-contained `codex exec` invocation with the prompt and input JSON supplied through stdin. It does not require Codex plugins to be installed. Plugin setup is only for manual interactive Codex sessions. Do not enable a production timer or release-path update for this package until an `sg02` dry-run and one controlled live run pass with the current runner build.

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
npm run -w @skillwiki/maintenance test
npm run -w @skillwiki/maintenance typecheck
npm run -w @skillwiki/maintenance build
rm -rf packages/agent-memory-trends/dist
```

Run dry-run checks. Dry-run mode must not commit, push, or heartbeat.

```bash
agent-memory-trends doctor
agent-memory-trends collect --dry-run
agent-memory-trends daily --dry-run
```

`daily --dry-run` still writes generated input and run-state files to the
configured vault so the synthesis path can be inspected. It invokes the provider
only when the real collector selected at least one research candidate. If no
candidate is selected, the provider path was not exercised; do not replace that
with a synthetic `codex exec` or `claude --print` prompt. For checks that must
not touch the real wiki, point `--vault` at a temporary vault checkout or
scratch directory.

Run generation-only mode when another orchestrator owns the transaction
boundary. This mode writes generated trend outputs and the operational run
manifest when there is a selected research signal. Quiet duplicate-only runs
write only agent-memory-trends run state. It does not refresh the session
brief, publish, push, or heartbeat.

```bash
agent-memory-trends daily --generate-only
```

For bounded local preview, add `--preview-only`. This skips the synthesis
agent and writes deterministic evidence, digest, and manifest files from the
selected candidate input. Use a temporary vault for smoke checks that must not
touch the real wiki.

```bash
agent-memory-trends daily --generate-only --preview-only --vault "$tmp_vault"
```

Run one manual live service start before enabling the timer.

```bash
sudo systemctl start agent-memory-trends.service
journalctl -u agent-memory-trends.service --no-pager -n 200
agent-memory-trends doctor
```

After the manual live run verifies the guarded maintenance result, digest,
evidence, TypeScript-rendered task/bug/idea captures if any, run JSON,
`synthesis_last_real_run` telemetry if synthesis was exercised, suppression
fields if any, and a clean or intentionally ahead vault state, enable the
timers.

```bash
sudo systemctl enable --now agent-memory-trends.timer
sudo systemctl enable --now agent-memory-session-brief-refresh.timer
sudo systemctl enable --now agent-memory-self-update.timer
```

## Safety Contract

The workflow must preserve these constraints:

- `packages/agent-memory-trends` remains private.
- `gh auth login` and `codex login` store credentials in each tool's normal user state; do not copy tokens into tracked config.
- `AGENT_MEMORY_TRENDS_HEARTBEAT_URL` belongs only in `/home/agent-memory/.config/agent-memory-trends/env`.
- Publisher validation must reject out-of-allowlist changes, raw rewrites, symlinks, executable generated files, oversized files, secret-like content, manifest mismatches, too many task captures, and too many web sources.
- Publisher validation must reject direct agent-written transcript captures that are not marked as TypeScript-rendered.
- The systemd timer must invoke the guarded maintenance runner; use the direct package `daily` command only for manual debugging.
- The heartbeat fires only after a successful push when the legacy direct publisher path is intentionally run manually.
- `sg01` is read-only for this workflow.
