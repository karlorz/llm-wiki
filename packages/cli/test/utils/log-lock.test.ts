import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
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
    if (r.ok) expect(r.data.path).toBe(logLockPath(dir));
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
    const acquired = await acquireLogLock(dir);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(releaseLogLock(acquired.data)).toEqual({ ok: true, data: { released: true } });
    expect(existsSync(logLockPath(dir))).toBe(false);
  });

  it("release is a no-op when no lock is held", () => {
    const dir = tmpVault();
    expect(() => releaseLogLock({ vault: dir, path: logLockPath(dir), ownerToken: "missing", acquired: "never" })).not.toThrow();
  });

  it("does not let a prior handle delete a stale-takeover lock", async () => {
    const dir = tmpVault();
    const prior = await acquireLogLock(dir);
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;

    const old = new Date(Date.now() - 60_000);
    utimesSync(logLockPath(dir), old, old);
    const takeover = await acquireLogLock(dir, { staleMs: 10_000 });
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) return;

    const beforeRelease = readFileSync(logLockPath(dir), "utf8");
    expect(releaseLogLock(prior.data).ok).toBe(false);
    expect(readFileSync(logLockPath(dir), "utf8")).toBe(beforeRelease);
    expect(releaseLogLock(takeover.data)).toEqual({ ok: true, data: { released: true } });
  });

  it("does not reclaim a stale lock when strict mode disables reclaiming", async () => {
    const dir = tmpVault();
    const prior = await acquireLogLock(dir);
    expect(prior.ok).toBe(true);
    const old = new Date(Date.now() - 60_000);
    utimesSync(logLockPath(dir), old, old);

    const strict = await acquireLogLock(dir, { retryMs: 0, staleMs: 10_000, reclaimStale: false });

    expect(strict.ok).toBe(false);
    if (prior.ok) expect(releaseLogLock(prior.data)).toEqual({ ok: true, data: { released: true } });
  });
});
