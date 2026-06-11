#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PACKAGE_ROOT/../.." && pwd)"

SERVICE_USER="${AGENT_MEMORY_USER:-agent-memory}"
SERVICE_HOME="${AGENT_MEMORY_HOME:-/home/$SERVICE_USER}"
REPO_DIR="${AGENT_MEMORY_REPO_DIR:-$SERVICE_HOME/llm-wiki}"
VAULT_DIR="${AGENT_MEMORY_VAULT_DIR:-$SERVICE_HOME/wiki}"
CONFIG_DIR="$SERVICE_HOME/.config/agent-memory-trends"
BIN_DIR="$SERVICE_HOME/.local/bin"
LOG_DIR="$SERVICE_HOME/.local/state/agent-memory-trends/logs"
ENV_FILE="$CONFIG_DIR/env"
ENV_EXAMPLE="$CONFIG_DIR/env.example"
UNIT_DIR="/etc/systemd/system"
ENABLE_TIMER=0

# Default env example path on sg02:
# /home/agent-memory/.config/agent-memory-trends/env.example

usage() {
  cat <<USAGE
Usage: sudo bash packages/agent-memory-trends/scripts/install-sg02.sh [--enable]

Prepares sg02 for the private agent-memory-trends nightly writer.

Options:
  --enable   Enable and start agent-memory-trends.timer after installing files.
             Use only after the manual auth gates and a manual live run pass.
  --help     Show this help.

Environment overrides:
  AGENT_MEMORY_USER      Dedicated Unix user (default: agent-memory)
  AGENT_MEMORY_HOME      Home directory (default: /home/agent-memory)
  AGENT_MEMORY_REPO_DIR  llm-wiki checkout path (default: /home/agent-memory/llm-wiki)
  AGENT_MEMORY_VAULT_DIR wiki checkout path (default: /home/agent-memory/wiki)
USAGE
}

log() {
  printf '[agent-memory-trends-install] %s\n' "$*"
}

fatal() {
  printf '[agent-memory-trends-install] FATAL: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fatal "run as root with sudo"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --enable)
      ENABLE_TIMER=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fatal "unknown argument: $1"
      ;;
  esac
done

require_root

if [ ! -f "$PACKAGE_ROOT/service-units/systemd/agent-memory-trends.service" ]; then
  fatal "missing service unit under $PACKAGE_ROOT/service-units/systemd"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating user $SERVICE_USER"
  useradd --system --create-home --home-dir "$SERVICE_HOME" --shell /bin/bash "$SERVICE_USER"
else
  log "user $SERVICE_USER already exists"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$CONFIG_DIR" "$BIN_DIR" "$LOG_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$REPO_DIR" "$VAULT_DIR"

if [ ! -f "$ENV_EXAMPLE" ]; then
  cat > "$ENV_EXAMPLE" <<EOF
# Copy to $ENV_FILE and edit on sg02.
# Do not commit this file after adding secrets.
#
# The GitHub CLI token is not stored here. Run gh auth login as $SERVICE_USER.
# Codex credentials are not stored here. Run codex login as $SERVICE_USER.
AGENT_MEMORY_TRENDS_REPO=$REPO_DIR
AGENT_MEMORY_TRENDS_VAULT=$VAULT_DIR
AGENT_MEMORY_TRENDS_CONFIG=$VAULT_DIR/projects/llm-wiki/architecture/agent-memory-research-sources.yaml
AGENT_MEMORY_TRENDS_LOG_DIR=$LOG_DIR
# AGENT_MEMORY_TRENDS_HEARTBEAT_URL=https://uptime.example.invalid/api/push/...
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_EXAMPLE"
  chmod 0600 "$ENV_EXAMPLE"
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 0600 "$ENV_FILE"
  log "created $ENV_FILE from env.example; edit heartbeat URL and paths before live run"
else
  log "preserving existing $ENV_FILE"
fi

cat > "$BIN_DIR/agent-memory-trends" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: agent-memory-trends <doctor|collect|daily|publish> [args...]" >&2
  exit 46
fi

COMMAND="$1"
shift

if [ -f "$HOME/.config/agent-memory-trends/env" ]; then
  # shellcheck source=/dev/null
  set -a
  source "$HOME/.config/agent-memory-trends/env"
  set +a
fi

REPO="${AGENT_MEMORY_TRENDS_REPO:-$HOME/llm-wiki}"
VAULT="${AGENT_MEMORY_TRENDS_VAULT:-$HOME/wiki}"
cd "$REPO"

export PATH="$HOME/.local/npm/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SKILLWIKI_PROJECT="${SKILLWIKI_PROJECT:-llm-wiki}"
export WIKI_PATH="${WIKI_PATH:-$VAULT}"

exec npm run -w @skillwiki/agent-memory-trends --silent "$COMMAND" -- "$@"
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$BIN_DIR/agent-memory-trends"
chmod 0750 "$BIN_DIR/agent-memory-trends"

cat > "$BIN_DIR/agent-memory-trends-daily" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

if [ -f "$HOME/.config/agent-memory-trends/env" ]; then
  # shellcheck source=/dev/null
  set -a
  source "$HOME/.config/agent-memory-trends/env"
  set +a
fi

REPO="${AGENT_MEMORY_TRENDS_REPO:-$HOME/llm-wiki}"
VAULT="${AGENT_MEMORY_TRENDS_VAULT:-$HOME/wiki}"
LOG_DIR="${AGENT_MEMORY_TRENDS_LOG_DIR:-$HOME/.local/state/agent-memory-trends/logs}"

mkdir -p "$LOG_DIR"
cd "$REPO"

export PATH="$HOME/.local/npm/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export SKILLWIKI_PROJECT="${SKILLWIKI_PROJECT:-llm-wiki}"
export WIKI_PATH="${WIKI_PATH:-$VAULT}"

npm run -w @skillwiki/agent-memory-trends --silent daily -- \
  --vault "$VAULT" \
  --repo "$REPO" \
  2>&1 | tee -a "$LOG_DIR/daily.log"
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$BIN_DIR/agent-memory-trends-daily"
chmod 0750 "$BIN_DIR/agent-memory-trends-daily"

install -m 0644 "$PACKAGE_ROOT/service-units/systemd/agent-memory-trends.service" \
  "$UNIT_DIR/agent-memory-trends.service"
install -m 0644 "$PACKAGE_ROOT/service-units/systemd/agent-memory-trends.timer" \
  "$UNIT_DIR/agent-memory-trends.timer"

systemctl daemon-reload

cat <<GATES

Prepared sg02 files. The installer stops before manual auth gates by default.

Manual auth gates to complete as $SERVICE_USER:
  1. gh auth login
  2. Verify Git SSH push from $VAULT_DIR to origin main.
  3. codex login
  4. codex doctor
  5. Edit $ENV_FILE and set AGENT_MEMORY_TRENDS_HEARTBEAT_URL if heartbeat is enabled.
  6. agent-memory-trends doctor
  7. agent-memory-trends collect --dry-run
  8. agent-memory-trends daily --dry-run
  9. sudo systemctl start agent-memory-trends.service
 10. journalctl -u agent-memory-trends.service --no-pager -n 200

Enable the timer only after a successful manual live run:
  sudo systemctl enable --now agent-memory-trends.timer

GATES

if [ "$ENABLE_TIMER" -eq 1 ]; then
  log "--enable supplied; enabling timer"
  systemctl enable --now agent-memory-trends.timer
else
  log "timer not enabled; rerun with --enable only after manual auth gates pass"
fi
