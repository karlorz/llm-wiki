import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { guardProtectedVaultWrite } from "../../src/utils/protected-vault-write-guard.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "guard-"));
}

function writeVaultFleet(): string {
  const vault = tempDir();
  const dir = join(vault, "projects", "llm-wiki", "architecture");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fleet.yaml"), `schema_version: 1
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
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
`);
  return vault;
}

describe("guardProtectedVaultWrite", () => {
  it("blocks vault mutations on protected snapshotter hosts", async () => {
    const vault = writeVaultFleet();

    const result = await guardProtectedVaultWrite({
      vault,
      command: "observe",
      hostId: "sg01",
      cwd: "/root/llm-wiki",
      home: "/root",
      user: "root",
      osHostname: "sg01",
      env: {},
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.exitCode).toBe(ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED);
      expect(result.result.error).toBe("PROTECTED_SNAPSHOTTER_WRITE_BLOCKED");
      expect(result.result.detail).toMatchObject({
        host_id: "sg01",
        command: "observe",
      });
    }
  });

  it("allows vault mutations on leaf hosts", async () => {
    const vault = writeVaultFleet();

    const result = await guardProtectedVaultWrite({
      vault,
      command: "observe",
      hostId: "macos-dev",
      cwd: "/Users/karlchow/Desktop/code/llm-wiki",
      home: "/Users/karlchow",
      user: "karlchow",
      osHostname: "macos-dev",
      env: {},
    });

    expect(result).toEqual({ blocked: false });
  });

  it("fails open when the fleet host identity cannot be resolved", async () => {
    const vault = writeVaultFleet();

    const result = await guardProtectedVaultWrite({
      vault,
      command: "observe",
      cwd: "/workspace/llm-wiki",
      home: tempDir(),
      user: "root",
      osHostname: "unknown-host",
      env: {},
    });

    expect(result).toEqual({ blocked: false });
  });
});
