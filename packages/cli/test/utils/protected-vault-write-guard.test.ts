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
  it("allows live-vault mutations on protected snapshotter hosts", async () => {
    const vault = writeVaultFleet();
    const home = tempDir();
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${vault}\nvault_sync.snapshot_worktree=/root/wiki-git\n`);

    const result = await guardProtectedVaultWrite({
      vault,
      command: "observe",
      hostId: "sg01",
      cwd: "/root/llm-wiki",
      home,
      user: "root",
      osHostname: "sg01",
      env: {},
    });

    expect(result).toEqual({ blocked: false });
  });

  it("blocks snapshot-worktree mutations on protected snapshotter hosts", async () => {
    const liveVault = writeVaultFleet();
    const home = tempDir();
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${liveVault}\nvault_sync.snapshot_worktree=/root/wiki-git\n`);

    const result = await guardProtectedVaultWrite({
      vault: "/root/wiki-git",
      command: "observe",
      hostId: "sg01",
      cwd: "/root/llm-wiki",
      home,
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
      expect(String(result.result.detail?.reason)).toContain("snapshot worktree");
    }
  });

  it("blocks alternate vault roots on protected snapshotter hosts when live vault is known", async () => {
    const liveVault = writeVaultFleet();
    const home = tempDir();
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${liveVault}\nvault_sync.snapshot_worktree=/root/wiki-git\n`);

    const result = await guardProtectedVaultWrite({
      vault: "/tmp/not-the-live-vault",
      command: "observe",
      hostId: "sg01",
      cwd: "/root/llm-wiki",
      home,
      user: "root",
      osHostname: "sg01",
      env: {},
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.exitCode).toBe(ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED);
      expect(String(result.result.detail?.reason)).toContain("outside the live vault path");
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
