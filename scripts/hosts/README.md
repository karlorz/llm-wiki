# Per-host environment files for vault-sync e2e tests

Each `.env` file in this directory defines a target host for remote
E2E scripts such as `e2e-remote.sh`, `e2e-plugin.sh`, and
`e2e-vault-sync-remote.sh`. Select a host via the
`HOST_ENV` environment variable:

```bash
HOST_ENV=scripts/hosts/sg02.env bash scripts/e2e-vault-sync-remote.sh
HOST_ENV=scripts/hosts/sg01.env bash scripts/e2e-plugin.sh   # read-only branch
HOST_ENV=scripts/hosts/sg02.env bash scripts/e2e-plugin.sh   # full branch only after provisioning Claude/plugin state
```

## Required keys

| Key | Description |
|-----|-------------|
| `SSH_HOST` | `~/.ssh/config` alias for the target host |
| `SSH_USER` | Account on the remote host |
| `HOST_CLASS` | `dev-macos` \| `dev-linux` \| `prod-linux` |
| `HOST_ROLE` | `leaf` \| `snapshotter` |
| `INSTALL_ALLOWED` | `true` \| `false` — gates `vault-sync-install` |
| `DESTRUCTIVE_ALLOWED` | `true` \| `false` — gates uninstall, service restart, script swap |
| `READONLY_VERIFY` | `true` \| `false` — when true, only `vault-sync-status` runs |
| `RCLONE_REQUIRED` | `true` \| `false` — whether rclone must be present on the host |
| `SCHEDULER` | `launchd` \| `systemd` \| `none` |
| `VAULT_PATH` | Absolute path to the vault on the host |
| `READONLY_GUARD_VAULT_PATH` | Optional absolute path used by read-only canonical vault guards when `VAULT_PATH` is a live mount but validation should run against a local snapshot checkout |
| `EXPECTED_VERSION_SOURCE` | Always `package.json` (read from repo root) |

## Validation rules

1. `READONLY_VERIFY=true` ⇒ `INSTALL_ALLOWED=false` AND `DESTRUCTIVE_ALLOWED=false`
2. `HOST_ROLE=snapshotter` requires the host to be the only one with that role in `fleet.yaml`
3. Hosts with `maintenance.skillwiki_satellite.enabled=true` in `fleet.yaml` must keep `VAULT_PATH` equal to `maintenance.skillwiki_satellite.vault_path`

Run `bash scripts/verify-manifests.sh` before remote E2E work. It includes
`scripts/verify-host-env-fleet.js`, which checks these committed host profiles
against the fleet manifest. When the private vault checkout is not present,
the verifier uses CI-safe fallback expectations for the committed sg01, sg02,
and macOS dev profiles.

## LXC hosts

Do not commit a static `lxc-test.env`. LXC environments are provisioned
by `devsh` at runtime.

**devsh contract (verified 2026-05-25):** `devsh` does not currently
support `--emit-env` or an `lxc` subcommand. VMs are created via
`devsh start ./project` which returns a VM ID; SSH access via
`devsh ssh <id>`.

**Stub path for Phase 6:** create `lxc-test.env` by hand after
provisioning a devsh VM, filling in the SSH alias and host details
from `devsh ls` / `devsh ssh <id>`. Add `lxc-test.env` to
`.gitignore` — it is ephemeral per CI run.

```bash
# After devsh start, derive the env file:
VM_ID=$(devsh start --json | jq -r '.id')
SSH_ALIAS="devsh-$VM_ID"  # from ~/.ssh/config or devsh ssh
cat > scripts/hosts/lxc-test.env <<EOF
SSH_HOST=$SSH_ALIAS
SSH_USER=root
HOST_CLASS=dev-linux
HOST_ROLE=leaf
INSTALL_ALLOWED=true
DESTRUCTIVE_ALLOWED=true
READONLY_VERIFY=false
RCLONE_REQUIRED=false
SCHEDULER=systemd
VAULT_PATH=/root/wiki
EXPECTED_VERSION_SOURCE=package.json
EOF
```

## Adding a new host

1. Copy an existing `.env` file.
2. Update all keys for the new host.
3. Add the host to `fleet.yaml` in the vault.
4. Update `e2e-vault-sync.yml` workflow if the host should run in CI.
5. Run `bash scripts/verify-manifests.sh` and fix any host/fleet drift.
