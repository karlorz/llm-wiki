import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLogLock, releaseLogLock, logLockPath } from "../../src/utils/log-lock.js";

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "vault-ll-"));
}

describe("log-lock", () => {
  it("acquires when the lock is free", async () => {
    const dir = tmpVault();
    const r = await acquireLogLock(dir);
    expect(r.ok).toBe(true);
    expect(existsSync(logLockPath(dir))).toBe(true);
  });

  it("fails fast when the lock is held and fresh", async () => {
    const dir = tmpVault();
    await acquireLogLock(dir); // hold it
    const start = Date.now();
    const r = await acquireLogLock(dir, { retryMs: 150, pollMs: 20 });
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("breaks and acquires a stale lock", async () => {
    const dir = tmpVault();
    await acquireLogLock(dir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(logLockPath(dir), old, old);
    const r = await acquireLogLock(dir, { staleMs: 10_000 });
    expect(r.ok).toBe(true);
  });

  it("release removes the lockfile", async () => {
    const dir = tmpVault();
    await acquireLogLock(dir);
    releaseLogLock(dir);
    expect(existsSync(logLockPath(dir))).toBe(false);
  });

  it("release is a no-op when no lock is held", () => {
    const dir = tmpVault();
    expect(() => releaseLogLock(dir)).not.toThrow();
  });
});
