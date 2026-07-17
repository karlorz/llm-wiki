import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  acquireManagedWriteLock,
  isManagedWriteLockOwnerAlive,
  managedWriteLockPath,
  reclaimDeadManagedWriteLockOwner,
  releaseManagedWriteLock,
} from "../../src/utils/managed-write-lock.js";

function initVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "managed-write-lock-"));
  execFileSync("git", ["init"], { cwd: vault });
  writeFileSync(join(vault, "seed"), "seed\n");
  return vault;
}

describe("managed write lock", () => {
  it("serializes the whole converge-and-write transaction and verifies ownership", () => {
    const vault = initVault();
    const first = acquireManagedWriteLock(vault, "page publish");
    expect(first.ok).toBe(true);
    const second = acquireManagedWriteLock(vault, "archive");
    expect(second).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
    if (!first.ok) throw new Error("expected lock");
    const disk = JSON.parse(readFileSync(first.data.path, "utf8"));
    expect(disk.owner_token).toBe(first.data.ownerToken);
    expect(releaseManagedWriteLock(first.data)).toEqual({ ok: true, data: { released: true } });
  });

  it("reclaims a dead-owner lock into recovery and allows a new acquire", () => {
    const vault = initVault();
    const path = managedWriteLockPath(vault);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        pid: 999999999,
        owner_token: "deadtoken",
        acquired: "2026-07-17T00:00:00.000Z",
        command: "wiki-pull",
      })}\n`,
    );
    expect(isManagedWriteLockOwnerAlive(999999999)).toBe(false);
    const reclaimed = reclaimDeadManagedWriteLockOwner(vault);
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error("expected reclaim");
    expect(reclaimed.data.reclaimed).toBe(true);
    expect(existsSync(path)).toBe(false);
    const recoveryDir = join(path, "..", "recovery");
    const files = readdirSync(recoveryDir).filter((f) => f.startsWith("stale-managed-write-lock-"));
    expect(files.length).toBe(1);
    const next = acquireManagedWriteLock(vault, "page publish");
    expect(next.ok).toBe(true);
    if (next.ok) releaseManagedWriteLock(next.data);
  });

  it("never reclaims a live owner pid", () => {
    const vault = initVault();
    const path = managedWriteLockPath(vault);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        pid: process.pid,
        owner_token: "livetoken",
        acquired: "2026-07-17T00:00:00.000Z",
        command: "wiki-pull",
      })}\n`,
    );
    const reclaimed = reclaimDeadManagedWriteLockOwner(vault);
    expect(reclaimed.ok).toBe(false);
    expect(existsSync(path)).toBe(true);
    const next = acquireManagedWriteLock(vault, "page publish");
    expect(next).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
  });

  it("does not reclaim dead owners while rebase state is present", () => {
    const vault = initVault();
    const path = managedWriteLockPath(vault);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        pid: 999999999,
        owner_token: "deadtoken",
        acquired: "2026-07-17T00:00:00.000Z",
        command: "wiki-pull",
      })}\n`,
    );
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: vault, encoding: "utf8" }).trim();
    const absGit = gitDir.startsWith("/") ? gitDir : join(vault, gitDir);
    mkdirSync(join(absGit, "rebase-merge"), { recursive: true });
    const reclaimed = reclaimDeadManagedWriteLockOwner(vault);
    expect(reclaimed.ok).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
