import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, releaseLock } from "../src/lock.js";

describe("acquireLock", () => {
  it("prevents a second maintenance instance until the first releases", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "skillwiki-maintenance-lock-")), "lock");

    const first = await acquireLock(lockDir, { owner: "first", now: new Date("2026-06-13T00:00:00Z") });
    expect(first.ok).toBe(true);

    const second = await acquireLock(lockDir, { owner: "second", now: new Date("2026-06-13T00:01:00Z"), waitMs: 0 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("LOCK_HELD");

    if (first.ok) await first.data.release();
    const third = await acquireLock(lockDir, { owner: "third", now: new Date("2026-06-13T00:02:00Z"), waitMs: 0 });
    expect(third.ok).toBe(true);
    if (third.ok) await third.data.release();
  });

  it("waits for the holder to release and then acquires", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "skillwiki-maintenance-lock-")), "lock");

    const first = await acquireLock(lockDir, { owner: "first", now: new Date("2026-06-13T00:00:00Z") });
    expect(first.ok).toBe(true);

    const startedAt = Date.now();
    const secondPromise = acquireLock(lockDir, {
      owner: "second",
      now: new Date("2026-06-13T00:01:00Z"),
      waitMs: 2000,
      pollMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (first.ok) await first.data.release();

    const second = await secondPromise;
    expect(second.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    if (second.ok) await second.data.release();
  });

  it("reclaims an expired lock whose recorded owner pid is dead", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "skillwiki-maintenance-lock-")), "lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      owner: "stale-owner",
      acquired_at: "2026-06-12T00:00:00Z",
      pid: 999999999,
      expires_at: "2026-06-12T00:30:00Z",
      token: "stale-token",
    }, null, 2) + "\n", "utf8");

    const result = await acquireLock(lockDir, { owner: "fresh", now: new Date("2026-06-13T00:00:00Z") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The stale owner record is preserved under <lock parent>/recovery/ before removal.
      const recovery = readdirSync(join(dirname(lockDir), "recovery"));
      expect(recovery.some((name) => name.includes("stale-token"))).toBe(true);
      await result.data.release();
    }
  });

  it("keeps failing fast on an expired lock whose recorded owner pid is alive", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "skillwiki-maintenance-lock-")), "lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      owner: "live-owner",
      acquired_at: new Date(Date.now() - 3600_000).toISOString(),
      pid: process.pid,
      expires_at: new Date(Date.now() - 1800_000).toISOString(),
      token: "live-token",
    }, null, 2) + "\n", "utf8");

    const result = await acquireLock(lockDir, { owner: "second", now: new Date(), waitMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("LOCK_HELD");
      expect(result.detail).toMatchObject({ message: `maintenance lock is held: ${lockDir}` });
    }
    // The live-owner lock must not be reclaimed.
    expect(existsSync(join(lockDir, "owner.json"))).toBe(true);
  });

  it("releasing with a foreign token is a no-op", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "skillwiki-maintenance-lock-")), "lock");

    const first = await acquireLock(lockDir, { owner: "first", now: new Date("2026-06-13T00:00:00Z") });
    expect(first.ok).toBe(true);

    const foreign = releaseLock(lockDir, "foreign-token");
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error).toBe("LOCK_HELD");
    expect(existsSync(lockDir)).toBe(true);

    if (first.ok) {
      const own = await first.data.release();
      expect(own.ok).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    }
  });
});
