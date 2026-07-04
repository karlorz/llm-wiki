import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runFleetContext, runFleetValidate } from "../../src/commands/fleet.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fleet-"));
}

function validFleet(): string {
  return `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
s3_remote: seaweed-wiki:cloud/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [s3, github]
    protected: false
    identity:
      hostnames: [macos-dev]
    access:
      from:
        macos-dev:
          status: local
          ssh_aliases: []
          users: [karlchow]
          transports: [local]
        sg01:
          status: absent
          transports: [public-ip]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
      public_addresses: [161.118.205.111]
    access:
      from:
        macos-dev:
          status: configured
          ssh_aliases: [sg01, cloudsg01]
          users: [root]
          transports: [public-ip]
  sg02:
    class: dev-linux
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [sg02]
      public_addresses: [161.118.233.237]
    access:
      from:
        macos-dev:
          status: configured
          ssh_aliases: [sg02, cloudsg02, sg02-agent, sg02-agent-memory]
          users: [root, agent, agent-memory]
          transports: [public-ip]
    maintenance:
      skillwiki_satellite:
        enabled: true
        user: agent-memory
        vault_path: /home/agent-memory/wiki
        repo_path: /home/agent-memory/llm-wiki
        ssh_alias: sg02-agent-memory
        scheduler: systemd
        timezone: Asia/Hong_Kong
        jobs:
          - self-update-check
          - vault-sync-preflight
          - agent-memory-trends-daily
          - session-brief-refresh
          - health-summary
        cadence:
          self_update_check: every-4-hours
          daily_window: "00:10 Asia/Hong_Kong"
`;
}

function writeFleet(text = validFleet()): string {
  const dir = tempDir();
  const file = join(dir, "fleet.yaml");
  writeFileSync(file, text);
  return file;
}

function writeVaultFleet(text = validFleet()): string {
  const vault = tempDir();
  const dir = join(vault, "projects", "llm-wiki", "architecture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fleet.yaml"), text);
  return vault;
}

describe("fleet validate", () => {
  it("accepts a schema_version 1 fleet manifest", async () => {
    const file = writeFleet();

    const r = await runFleetValidate({ file });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.host_count).toBe(3);
      expect(r.result.data.snapshotter).toBe("sg01");
    }
  });

  it("rejects a fleet manifest without exactly one snapshotter", async () => {
    const file = writeFleet(validFleet().replace("role: snapshotter", "role: leaf"));

    const r = await runFleetValidate({ file });

    expect(r.exitCode).toBe(ExitCode.FLEET_MANIFEST_INVALID);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.errors.some((e) => e.path === "hosts")).toBe(true);
    }
  });
});

describe("fleet context", () => {
  it("builds compact runtime host context from an explicit host id", async () => {
    const vault = writeVaultFleet();

    const r = await runFleetContext({
      vault,
      hostId: "sg01",
      osHostname: "sg01",
      user: "root",
      cwd: "/root/llm-wiki",
      home: "/root",
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.host_id).toBe("sg01");
      expect(r.result.data.source).toBe("host-id");
      expect(r.result.data.identity_status).toBe("known");
      expect(r.result.data.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.result.data.warnings).toEqual([]);
      expect(r.result.data.resolver_trace[0]).toEqual({ source: "--host-id", status: "matched", value: "sg01" });
      expect(r.result.data.markdown).toContain("## Runtime Host Context");
      expect(r.result.data.markdown).toContain("Identity status: `known`");
      expect(r.result.data.markdown).toContain("Identity resolution: `--host-id` -> `sg01`");
      expect(r.result.data.markdown).toContain("Current machine: `sg01`");
      expect(r.result.data.markdown).toContain("Fleet role: `snapshotter`; protected: `true`; writes_to: `github`");
      expect(r.result.data.markdown).toContain("Self SSH aliases known in fleet: `sg01`, `cloudsg01`");
      expect(r.result.data.markdown).toContain("Declared outbound SSH from this source: none");
      expect(r.result.data.markdown).toContain("protected snapshotter host");
      expect(r.result.data.markdown).toContain("Live-vault authoring at the resolved `skillwiki path` is allowed here");
      expect(r.result.data.markdown).toContain("Do not mutate snapshot worktrees or repo-local project workspaces");
    }
  });

  it("reads SKILLWIKI_HOST_ID from ~/.skillwiki/.env", async () => {
    const vault = writeVaultFleet();
    const home = tempDir();
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    writeFileSync(join(home, ".skillwiki", ".env"), "SKILLWIKI_HOST_ID=macos-dev\n");

    const r = await runFleetContext({
      vault,
      osHostname: "Karl-MacBook-Pro",
      user: "karlchow",
      cwd: "/Users/karlchow/Desktop/code/llm-wiki",
      home,
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.host_id).toBe("macos-dev");
      expect(r.result.data.source).toBe("~/.skillwiki/.env:SKILLWIKI_HOST_ID");
      expect(r.result.data.identity_status).toBe("known");
      expect(r.result.data.resolver_trace.map((step) => step.status)).toContain("matched");
      expect(r.result.data.markdown).toContain("Resolver trace: `--host-id` unset; `SKILLWIKI_HOST_ID` unset; `AGENT_HOST_ID` unset; `~/.skillwiki/.env:SKILLWIKI_HOST_ID` matched `macos-dev`");
      expect(r.result.data.markdown).toContain("`sg01` via `sg01`, `cloudsg01` (users: `root`)");
      expect(r.result.data.markdown).toContain("`sg02` via `sg02`, `cloudsg02`, `sg02-agent`, `sg02-agent-memory` (users: `root`, `agent`, `agent-memory`)");
      expect(r.result.data.markdown).toContain("do not assume undeclared hosts have reciprocal SSH access");
    }
  });

  it("injects an unknown-host warning when identity cannot be resolved", async () => {
    const vault = writeVaultFleet();

    const r = await runFleetContext({
      vault,
      osHostname: "localhost",
      user: "root",
      cwd: "/workspace/llm-wiki",
      home: tempDir(),
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.host_id).toBeUndefined();
      expect(r.result.data.identity_status).toBe("unknown");
      expect(r.result.data.warnings).toContain("host identity is unresolved");
      expect(r.result.data.resolver_trace.at(-1)).toEqual({ source: "hostname", status: "unmatched", value: "localhost" });
      expect(r.result.data.markdown).toContain("Current machine: unknown");
      expect(r.result.data.markdown).toContain("Identity status: `unknown`");
      expect(r.result.data.markdown).toContain("Warnings: host identity is unresolved");
      expect(r.result.data.markdown).toContain("host identity is unresolved");
      expect(r.result.data.markdown).toContain("do not assume local vs remote role");
    }
  });

  it("keeps invalid identity diagnostic non-fatal when a configured host id is absent from fleet", async () => {
    const vault = writeVaultFleet();

    const r = await runFleetContext({
      vault,
      env: { AGENT_HOST_ID: "ptcloud" },
      osHostname: "cmux-task-123",
      user: "root",
      cwd: "/workspace/llm-wiki",
      home: tempDir(),
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.host_id).toBe("ptcloud");
      expect(r.result.data.source).toBe("AGENT_HOST_ID");
      expect(r.result.data.identity_status).toBe("invalid");
      expect(r.result.data.warnings).toContain("resolved host id `ptcloud` from AGENT_HOST_ID is not in fleet.yaml");
      expect(r.result.data.resolver_trace).toContainEqual({ source: "AGENT_HOST_ID", status: "matched", value: "ptcloud" });
      expect(r.result.data.markdown).toContain("Current machine: unknown");
      expect(r.result.data.markdown).toContain("Identity status: `invalid`");
      expect(r.result.data.markdown).toContain("resolved host id `ptcloud` from AGENT_HOST_ID is not in fleet.yaml");
      expect(r.result.data.markdown).toContain("do not trust this identity");
    }
  });

  it("renders sg02 skillwiki satellite metadata separately from fleet sync role", async () => {
    const vault = writeVaultFleet();

    const r = await runFleetContext({
      vault,
      hostId: "sg02",
      osHostname: "sg02",
      user: "agent-memory",
      cwd: "/home/agent-memory/llm-wiki",
      home: "/home/agent-memory",
    });

    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.markdown).toContain("Fleet role: `leaf`; protected: `false`; writes_to: `github`");
      expect(r.result.data.markdown).toContain("Maintenance role: `skillwiki satellite`; user: `agent-memory`; ssh: `sg02-agent-memory`");
      expect(r.result.data.markdown).toContain("maintenance vault: `/home/agent-memory/wiki`; repo: `/home/agent-memory/llm-wiki`; scheduler: `systemd`");
      expect(r.result.data.markdown).toContain("jobs: `self-update-check`, `vault-sync-preflight`, `agent-memory-trends-daily`, `session-brief-refresh`, `health-summary`");
    }
  });
});
