import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageFile(path: string): string {
  const absolutePath = join(packageRoot, path);
  expect(existsSync(absolutePath), `${path} should exist`).toBe(true);
  return readFileSync(absolutePath, "utf8");
}

describe("sg02 systemd rollout artifacts", () => {
  it("ships a constrained system-level service unit", () => {
    const service = readPackageFile("service-units/systemd/agent-memory-trends.service");

    expect(service).toContain("[Unit]");
    expect(service).toContain("[Service]");
    expect(service).toContain("Type=exec");
    expect(service).toContain("User=agent-memory");
    expect(service).toContain("EnvironmentFile=/home/agent-memory/.config/agent-memory-trends/env");
    expect(service).toContain("ExecStart=/home/agent-memory/.local/bin/agent-memory-trends-daily");
    expect(service).toContain("RuntimeMaxSec=1800");
    expect(service).toContain("Nice=10");
    expect(service).toContain("NoNewPrivileges=true");
  });

  it("ships the HKT persistent nightly timer", () => {
    const timer = readPackageFile("service-units/systemd/agent-memory-trends.timer");

    expect(timer).toContain("[Timer]");
    expect(timer).toContain("OnCalendar=*-*-* 00:10:00 Asia/Hong_Kong");
    expect(timer).toContain("RandomizedDelaySec=300");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("AccuracySec=60s");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("ships dedicated session-brief refresh service and timer", () => {
    const service = readPackageFile("service-units/systemd/agent-memory-session-brief-refresh.service");
    const timer = readPackageFile("service-units/systemd/agent-memory-session-brief-refresh.timer");

    expect(service).toContain("Description=SkillWiki agent memory session brief refresh");
    expect(service).toContain("User=agent-memory");
    expect(service).toContain("Environment=SKILLWIKI_MAINTENANCE_MODE=session-brief-refresh");
    expect(service).toContain("ExecStart=/home/agent-memory/.local/bin/agent-memory-trends-daily");
    expect(service).toContain("RuntimeMaxSec=900");
    expect(timer).toContain("OnCalendar=*-*-* 01:05:00 Asia/Hong_Kong");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=agent-memory-session-brief-refresh.service");
  });

  it("ships a four-hour self-update service and timer", () => {
    const service = readPackageFile("service-units/systemd/agent-memory-self-update.service");
    const timer = readPackageFile("service-units/systemd/agent-memory-self-update.timer");

    expect(service).toContain("Description=SkillWiki agent memory self-update");
    expect(service).toContain("User=agent-memory");
    expect(service).toContain("Environment=SKILLWIKI_MAINTENANCE_MODE=self-update-apply");
    expect(service).toContain("ExecStart=/home/agent-memory/.local/bin/agent-memory-trends-daily");
    expect(service).toContain("RuntimeMaxSec=1800");
    expect(timer).toContain("OnCalendar=*-*-* 00/4:20:00 Asia/Hong_Kong");
    expect(timer).toContain("RandomizedDelaySec=900");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=agent-memory-self-update.service");
  });

  it("ships a guided sg02 installer that stops before manual auth gates by default", () => {
    const installer = readPackageFile("scripts/install-sg02.sh");

    expect(installer).toContain("#!/usr/bin/env bash");
    expect(installer).toContain("set -Eeuo pipefail");
    expect(installer).toContain("--enable");
    expect(installer).toContain("useradd");
    expect(installer).toContain("agent-memory");
    expect(installer).toContain("/home/agent-memory/.config/agent-memory-trends/env.example");
    expect(installer).toContain("cat > \"$BIN_DIR/agent-memory-trends\"");
    expect(installer).toContain("set -a");
    expect(installer).toContain("set +a");
    expect(installer).toContain("export PATH=\"$HOME/.local/npm/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH\"");
    expect(installer).toContain("export WIKI_PATH=\"${WIKI_PATH:-$VAULT}\"");
    expect(installer).toContain("require('./packages/agent-memory-trends/package.json').version");
    expect(installer).toContain("npm run -w @skillwiki/agent-memory-trends --silent \"$COMMAND\" --");
    expect(installer).toContain("manual auth gates");
    expect(installer).toContain("gh auth login");
    expect(installer).toContain("codex login");
    expect(installer).toContain("codex doctor");
    expect(installer).toContain("agent-memory-trends daily --dry-run");
    expect(installer).toContain("npm run -w @skillwiki/maintenance --silent build");
    expect(installer).toContain("node \"$REPO/packages/skillwiki-maintenance/dist/cli.js\" run");
    expect(installer).toContain("systemctl daemon-reload");
    expect(installer).toContain("systemctl enable --now agent-memory-trends.timer");
    expect(installer).toContain("agent-memory-session-brief-refresh.timer");
    expect(installer).toContain("agent-memory-self-update.timer");
    expect(installer).toContain("systemctl enable --now agent-memory-session-brief-refresh.timer");
    expect(installer).toContain("systemctl enable --now agent-memory-self-update.timer");

    const dailyWrapperStart = installer.indexOf('cat > "$BIN_DIR/agent-memory-trends-daily"');
    expect(dailyWrapperStart).toBeGreaterThan(-1);
    const dailyWrapper = installer.slice(dailyWrapperStart);
    const argumentGuard = dailyWrapper.indexOf('if [ "$#" -ne 0 ]; then');
    const dailyCommand = dailyWrapper.indexOf("node \"$REPO/packages/skillwiki-maintenance/dist/cli.js\" run");

    expect(argumentGuard).toBeGreaterThan(-1);
    expect(argumentGuard).toBeLessThan(dailyCommand);
    expect(dailyWrapper).toContain("agent-memory-trends-daily does not accept arguments");
    expect(dailyWrapper).toContain("SKILLWIKI_MAINTENANCE_FLEET");
    expect(dailyWrapper).toContain("SKILLWIKI_MAINTENANCE_MODE=\"${SKILLWIKI_MAINTENANCE_MODE:-daily}\"");
    expect(dailyWrapper).toContain("--host \"$SKILLWIKI_MAINTENANCE_HOST_ID\"");
    expect(dailyWrapper).toContain("--mode \"$SKILLWIKI_MAINTENANCE_MODE\"");
  });

  it("documents the manual rollout gates without tracked secrets", () => {
    const readme = readPackageFile("README.md");

    expect(readme).toContain("Pre-flight Checklist");
    expect(readme).toContain("export PATH=\"$HOME/.local/npm/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH\"");
    expect(readme).toContain("command -v \"$tool\"");
    expect(readme).toContain("gh auth login");
    expect(readme).toContain("Git SSH push");
    expect(readme).toContain("codex login");
    expect(readme).toContain("codex doctor");
    expect(readme).toContain("does not require Codex plugins");
    expect(readme).toContain("publisher gate shells out to `skillwiki validate`, `skillwiki lint`, and `skillwiki audit`");
    expect(readme).toContain("AGENT_MEMORY_TRENDS_HEARTBEAT_URL");
    expect(readme).toContain("agent-memory-trends doctor");
    expect(readme).toContain("agent-memory-trends collect --dry-run");
    expect(readme).toContain("agent-memory-trends daily --dry-run");
    expect(readme).toContain("sudo systemctl start agent-memory-trends.service");
    expect(readme).toContain("sudo systemctl enable --now agent-memory-trends.timer");
    expect(readme).not.toMatch(/(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,})/);
  });
});
