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
      expect(r.result.data.markdown).toContain("## Runtime Host Context");
      expect(r.result.data.markdown).toContain("Current machine: `sg01`");
      expect(r.result.data.markdown).toContain("Fleet role: `snapshotter`; protected: `true`; writes_to: `github`");
      expect(r.result.data.markdown).toContain("Self SSH aliases known in fleet: `sg01`, `cloudsg01`");
      expect(r.result.data.markdown).toContain("Declared outbound SSH from this source: none");
      expect(r.result.data.markdown).toContain("do not SSH to self aliases");
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
      expect(r.result.data.markdown).toContain("Declared outbound SSH from this source: `sg01`, `sg02`");
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
      expect(r.result.data.markdown).toContain("Current machine: unknown");
      expect(r.result.data.markdown).toContain("host identity is unresolved");
      expect(r.result.data.markdown).toContain("do not assume local vs remote role");
    }
  });
});
