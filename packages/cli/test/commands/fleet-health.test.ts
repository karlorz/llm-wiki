import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runFleetHealth } from "../../src/commands/fleet-health.js";

const { LOCAL_SATELLITE_VAULT, localLatestRunFixture } = vi.hoisted(() => ({
  LOCAL_SATELLITE_VAULT: "/home/agent-memory/wiki",
  localLatestRunFixture: { body: null as Record<string, unknown> | null },
}));

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { satelliteLatestRunPath } = await import("../../src/utils/satellite-run-health.js");
  const latestPath = satelliteLatestRunPath(LOCAL_SATELLITE_VAULT);
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (String(path) === latestPath) {
        return localLatestRunFixture.body !== null;
      }
      return actual.existsSync(path);
    },
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1]
    ) => {
      if (String(path) === latestPath && localLatestRunFixture.body !== null) {
        return JSON.stringify(localLatestRunFixture.body) + "\n";
      }
      return actual.readFileSync(path, options);
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fleet-health-"));
}

function writeVaultFleet(vault: string, text: string): void {
  const dir = join(vault, "projects", "llm-wiki", "architecture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fleet.yaml"), text);
}

function setLocalLatestRun(body: Record<string, unknown> | null): void {
  localLatestRunFixture.body = body;
}

function fleetWithLocalSatellite(): string {
  return `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
hosts:
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
  local-sat:
    class: dev-linux
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [local-sat]
    maintenance:
      skillwiki_satellite:
        enabled: true
        user: agent-memory
        vault_path: ${LOCAL_SATELLITE_VAULT}
        repo_path: /home/agent-memory/llm-wiki
        ssh_alias: local-sat-alias
        scheduler: systemd
        jobs:
          - agent-memory-trends-daily
`;
}

const FLEET_REMOTE_SATELLITE = `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
hosts:
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [macos-dev]
  sg02:
    class: dev-linux
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [sg02]
    access:
      from:
        macos-dev:
          status: configured
          ssh_aliases: [sg02-agent-memory]
          users: [agent-memory]
          transports: [public-ip]
    maintenance:
      skillwiki_satellite:
        enabled: true
        user: agent-memory
        vault_path: /home/agent-memory/wiki
        repo_path: /home/agent-memory/llm-wiki
        ssh_alias: sg02-agent-memory
        scheduler: systemd
        jobs:
          - agent-memory-trends-daily
`;

const FLEET_NO_SATELLITE = `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
hosts:
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
`;

describe("fleet health", () => {
  beforeEach(() => {
    localLatestRunFixture.body = null;
    execSyncMock.mockReset();
  });

  it("exits 0 with message when no satellite hosts configured", async () => {
    const vault = tempDir();
    writeVaultFleet(vault, FLEET_NO_SATELLITE);

    const r = await runFleetHealth({
      vault,
      hostId: "macos-dev",
      env: {},
      home: tempDir(),
      osHostname: "macos-dev",
      deps: { platform: () => "darwin", execSync: execSyncMock },
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.hosts).toEqual([]);
      expect(r.result.data.humanHint).toContain("no satellite hosts");
    }
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("local satellite host with fail status → non-zero exit and fail row", async () => {
    const vault = tempDir();
    writeVaultFleet(vault, fleetWithLocalSatellite());
    setLocalLatestRun({
      status: "fail",
      finished_at: new Date().toISOString(),
      failure_class: "DEDUPE_SCAN_FAILED",
    });

    const r = await runFleetHealth({
      vault,
      hostId: "local-sat",
      env: {},
      home: tempDir(),
      osHostname: "local-sat",
      deps: {
        platform: () => "linux",
        execSync: (cmd: string) => {
          if (cmd.includes("systemctl is-active")) return "active\n";
          throw new Error(`unexpected: ${cmd}`);
        },
      },
    });

    expect(r.exitCode).toBe(ExitCode.FLEET_SATELLITE_HEALTH_FAILED);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.hosts).toHaveLength(1);
      expect(r.result.data.hosts[0]?.host).toBe("local-sat");
      expect(r.result.data.hosts[0]?.last_run_status).toBe("fail");
      expect(r.result.data.hosts[0]?.failure_class).toBe("DEDUPE_SCAN_FAILED");
      expect(r.result.data.hosts[0]?.reachable).toBe("yes");
      expect(r.result.data.humanHint).toContain("fail");
    }
  });

  it("remote satellite reachable → SSH probe uses declared alias", async () => {
    const vault = tempDir();
    writeVaultFleet(vault, FLEET_REMOTE_SATELLITE);
    const finished = new Date().toISOString();
    execSyncMock.mockReturnValue(
      `${JSON.stringify({ status: "success", finished_at: finished })}\n__SW_TIMER__\nactive\n__SW_FAILED__\nunknown\n`
    );

    const r = await runFleetHealth({
      vault,
      hostId: "macos-dev",
      env: {},
      home: tempDir(),
      osHostname: "macos-dev",
      deps: { platform: () => "darwin", execSync: execSyncMock },
    });

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const cmd = String(execSyncMock.mock.calls[0]?.[0]);
    expect(cmd).toContain("sg02-agent-memory");
    expect(cmd).toContain("ConnectTimeout=10");
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.hosts[0]?.host).toBe("sg02");
      expect(r.result.data.hosts[0]?.reachable).toBe("yes");
      expect(r.result.data.hosts[0]?.last_run_status).toBe("success");
      expect(r.result.data.hosts[0]?.timer).toBe("active");
    }
  });

  it("remote satellite SSH fails → unreachable row and non-zero exit", async () => {
    const vault = tempDir();
    writeVaultFleet(vault, FLEET_REMOTE_SATELLITE);
    execSyncMock.mockImplementation(() => {
      throw new Error("Connection timed out");
    });

    const r = await runFleetHealth({
      vault,
      hostId: "macos-dev",
      env: {},
      home: tempDir(),
      osHostname: "macos-dev",
      deps: { platform: () => "darwin", execSync: execSyncMock },
    });

    expect(r.exitCode).toBe(ExitCode.FLEET_SATELLITE_HEALTH_FAILED);
    if (r.result.ok) {
      expect(r.result.data.hosts[0]?.reachable).toBe("no");
      expect(r.result.data.humanHint).toMatch(/\|\s*no\s*$/m);
    }
  });

  it("all hosts healthy → exit 0", async () => {
    const vault = tempDir();
    writeVaultFleet(vault, fleetWithLocalSatellite());
    setLocalLatestRun({ status: "success", finished_at: new Date().toISOString() });

    const r = await runFleetHealth({
      vault,
      hostId: "local-sat",
      env: {},
      home: tempDir(),
      osHostname: "local-sat",
      deps: {
        platform: () => "linux",
        execSync: (cmd: string) => {
          if (cmd.includes("systemctl is-active")) return "active\n";
          throw new Error(cmd);
        },
      },
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.hosts[0]?.healthy).toBe(true);
    }
  });

  it("remote satellite with no declared SSH access from local host → no-access row, exit 0, no SSH attempt", async () => {
    const vault = tempDir();
    writeVaultFleet(vault, FLEET_REMOTE_SATELLITE);
    // Run as sg01 (no access.from.sg01 declared for sg02) — must NOT probe.
    const r = await runFleetHealth({
      vault,
      hostId: "sg01",
      env: {},
      home: tempDir(),
      osHostname: "sg01",
      deps: { platform: () => "linux", execSync: execSyncMock },
    });

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.hosts[0]?.reachable).toBe("no-access");
      expect(r.result.data.hosts[0]?.healthy).toBe(true);
      expect(r.result.data.humanHint).toContain("no-access");
    }
  });
});