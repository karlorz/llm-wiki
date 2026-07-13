import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  getSessionId,
  getCwdHash,
  getCliSessionId,
  lockPath,
  readLock,
  isStale,
  acquireLock,
  acquireOwnedSyncLock,
  releaseLock,
  releaseOwnedSyncLock,
  type LockFile,
} from "../../src/utils/sync-lock.js";

function vault(): string {
  return mkdtempSync(join(tmpdir(), "sl-"));
}

describe("getSessionId", () => {
  const saved = { c: process.env.CLAUDE_SESSION_ID, s: process.env.SKILLWIKI_SESSION_ID };
  beforeEach(() => { delete process.env.CLAUDE_SESSION_ID; delete process.env.SKILLWIKI_SESSION_ID; });
  afterEach(() => {
    if (saved.c === undefined) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = saved.c;
    if (saved.s === undefined) delete process.env.SKILLWIKI_SESSION_ID; else process.env.SKILLWIKI_SESSION_ID = saved.s;
  });

  it("prefers CLAUDE_SESSION_ID", () => {
    process.env.CLAUDE_SESSION_ID = "claude-1";
    process.env.SKILLWIKI_SESSION_ID = "sw-1";
    expect(getSessionId()).toBe("claude-1");
  });

  it("falls back to SKILLWIKI_SESSION_ID", () => {
    process.env.SKILLWIKI_SESSION_ID = "sw-2";
    expect(getSessionId()).toBe("sw-2");
  });

  it("falls back to the pid when no env vars are set", () => {
    expect(getSessionId()).toBe(process.pid.toString());
  });
});

describe("getCwdHash", () => {
  it("returns the first 8 hex chars of sha256(path)", () => {
    const expected = createHash("sha256").update("/some/path").digest("hex").slice(0, 8);
    expect(getCwdHash("/some/path")).toBe(expected);
  });

  it("is deterministic", () => {
    expect(getCwdHash("/x")).toBe(getCwdHash("/x"));
  });
});

describe("getCliSessionId", () => {
  const saved = { c: process.env.CLAUDE_SESSION_ID, s: process.env.SKILLWIKI_SESSION_ID };
  beforeEach(() => { delete process.env.CLAUDE_SESSION_ID; delete process.env.SKILLWIKI_SESSION_ID; });
  afterEach(() => {
    if (saved.c === undefined) delete process.env.CLAUDE_SESSION_ID; else process.env.CLAUDE_SESSION_ID = saved.c;
    if (saved.s === undefined) delete process.env.SKILLWIKI_SESSION_ID; else process.env.SKILLWIKI_SESSION_ID = saved.s;
  });

  it("uses explicit session environment before cwd fallback", () => {
    process.env.CLAUDE_SESSION_ID = "claude-cli";
    expect(getCliSessionId("/repo")).toBe("claude-cli");
  });

  it("falls back to a deterministic cwd-based CLI session id", () => {
    expect(getCliSessionId("/repo")).toBe(`cli-${getCwdHash("/repo")}`);
    expect(getCliSessionId("/repo")).toBe(getCliSessionId("/repo"));
  });
});

describe("lockPath", () => {
  it("resolves to <vault>/.skillwiki/sync.lock", () => {
    expect(lockPath("/v")).toBe(join("/v", ".skillwiki", "sync.lock"));
  });
});

describe("readLock", () => {
  it("returns null when no lockfile exists", () => {
    expect(readLock(vault())).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const dir = vault();
    acquireLock(dir); // creates .skillwiki dir + lock
    writeFileSync(lockPath(dir), "not json{");
    expect(readLock(dir)).toBeNull();
  });

  it("parses a valid lockfile", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "abc", summary: "x" });
    const lock = readLock(dir);
    expect(lock?.session_id).toBe("abc");
  });
});

describe("isStale", () => {
  const base: LockFile = {
    session_id: "s", pid: 1, cwd: "/c", summary: "x",
    acquired: "2026-01-01T00:00:00.000Z", expires: "2026-01-01T00:30:00.000Z",
  };

  it("is stale when expires < now", () => {
    expect(isStale(base, new Date("2026-01-01T01:00:00.000Z"))).toBe(true);
  });

  it("is not stale when expires > now", () => {
    expect(isStale(base, new Date("2026-01-01T00:10:00.000Z"))).toBe(false);
  });
});

describe("acquireLock / releaseLock", () => {
  it("acquires a free lock", () => {
    const dir = vault();
    const r = acquireLock(dir, { sessionId: "me" });
    expect(r.ok).toBe(true);
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it("refuses a lock held by another fresh session", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "other", ttlMinutes: 30 });
    const r = acquireLock(dir, { sessionId: "me" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.held.session_id).toBe("other");
  });

  it("breaks a stale lock", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "other", ttlMinutes: -1 }); // already expired
    const r = acquireLock(dir, { sessionId: "me" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.session_id).toBe("me");
  });

  it("force-acquires regardless of holder", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "other", ttlMinutes: 30 });
    const r = acquireLock(dir, { sessionId: "me", force: true });
    expect(r.ok).toBe(true);
  });

  it("overwrites an unparseable existing lock", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "other" });
    writeFileSync(lockPath(dir), "garbage{");
    const r = acquireLock(dir, { sessionId: "me" });
    expect(r.ok).toBe(true);
  });

  it("releases a lock held by this session", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "me" });
    const r = releaseLock(dir, { sessionId: "me" });
    expect(r.released).toBe(true);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("does not release a lock held by another session", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "other" });
    const r = releaseLock(dir, { sessionId: "me" });
    expect(r.released).toBe(false);
    expect(existsSync(lockPath(dir))).toBe(true);
  });

  it("force-releases another session's lock and returns the prior holder", () => {
    const dir = vault();
    acquireLock(dir, { sessionId: "other" });
    const r = releaseLock(dir, { sessionId: "me", force: true });
    expect(r.released).toBe(true);
    expect(r.prior?.session_id).toBe("other");
  });

  it("release on a missing lockfile is a no-op", () => {
    const dir = vault();
    expect(releaseLock(dir).released).toBe(false);
  });
});

describe("acquireOwnedSyncLock / releaseOwnedSyncLock", () => {
  it("does not let a same-CWD loser release the winner's publication lock", () => {
    const dir = vault();
    const winner = acquireOwnedSyncLock(dir, { summary: "winner", ttlMinutes: 1 });
    expect(winner.ok).toBe(true);
    const loser = acquireOwnedSyncLock(dir, { summary: "loser", ttlMinutes: 1 });
    expect(loser.ok).toBe(false);
    if (!winner.ok) return;

    expect(releaseOwnedSyncLock({ ...winner.data, ownerToken: "not-the-winner" }).ok).toBe(false);
    expect(readLock(dir)?.owner_token).toBe(winner.data.ownerToken);
    expect(releaseOwnedSyncLock(winner.data)).toEqual({ ok: true, data: { released: true } });
  });

  it("fails closed on malformed existing locks in strict mode", () => {
    const dir = vault();
    const path = lockPath(dir);
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    writeFileSync(path, "not-json\n");

    const result = acquireOwnedSyncLock(dir, { summary: "publisher", ttlMinutes: 1 });

    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("not-json\n");
  });

  it("fails closed on stale existing locks in strict mode", () => {
    const dir = vault();
    const held = acquireLock(dir, { sessionId: "stale", ttlMinutes: -1 });
    expect(held.ok).toBe(true);
    const before = readFileSync(lockPath(dir), "utf8");

    const result = acquireOwnedSyncLock(dir, { summary: "publisher", ttlMinutes: 1 });

    expect(result.ok).toBe(false);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(before);
  });
});
