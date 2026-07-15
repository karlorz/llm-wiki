import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { acquireManagedWriteLock, releaseManagedWriteLock } from "../../src/utils/managed-write-lock.js";

describe("managed write lock", () => {
  it("serializes the whole converge-and-write transaction and verifies ownership", () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-write-lock-"));
    execFileSync("git", ["init"], { cwd: vault });
    writeFileSync(join(vault, "seed"), "seed\n");
    const first = acquireManagedWriteLock(vault, "page publish");
    expect(first.ok).toBe(true);
    const second = acquireManagedWriteLock(vault, "archive");
    expect(second).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
    if (!first.ok) throw new Error("expected lock");
    const disk = JSON.parse(readFileSync(first.data.path, "utf8"));
    expect(disk.owner_token).toBe(first.data.ownerToken);
    expect(releaseManagedWriteLock(first.data)).toEqual({ ok: true, data: { released: true } });
  });
});
