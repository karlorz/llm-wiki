import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.js";

describe("acquireLock", () => {
  it("prevents a second maintenance instance until the first releases", async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), "skillwiki-maintenance-lock-")), "lock");

    const first = acquireLock(lockDir, { owner: "first", now: new Date("2026-06-13T00:00:00Z") });
    expect(first.ok).toBe(true);

    const second = acquireLock(lockDir, { owner: "second", now: new Date("2026-06-13T00:01:00Z") });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("LOCK_HELD");

    if (first.ok) await first.data.release();
    const third = acquireLock(lockDir, { owner: "third", now: new Date("2026-06-13T00:02:00Z") });
    expect(third.ok).toBe(true);
    if (third.ok) await third.data.release();
  });
});
