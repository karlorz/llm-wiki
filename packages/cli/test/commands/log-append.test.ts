import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogAppend } from "../../src/commands/log-append.js";
import { acquireLogLock, logLockPath, releaseLogLock } from "../../src/utils/log-lock.js";

function vault(entries = 2): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-la-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  let log = "# Vault Log\n\n";
  for (let i = 0; i < entries; i++) {
    log += `## [2026-01-0${i + 1}] action | entry ${i}\n\n- detail\n\n`;
  }
  writeFileSync(join(dir, "log.md"), log);
  return dir;
}

const ENTRY = "## [2026-05-30] retro | loop cycle: x";

describe("runLogAppend", () => {
  it("appends to the END of log.md and increments entry count", async () => {
    const dir = vault(2);
    const r = await runLogAppend({ vault: dir, content: ENTRY });
    expect(r.exitCode).toBe(0);
    const text = readFileSync(join(dir, "log.md"), "utf8");
    expect(text.trimEnd().endsWith(ENTRY)).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.entries_before).toBe(2);
      expect(r.result.data.entries_after).toBe(3);
      expect(r.result.data.appended).toBe(true);
    }
  });

  it("separates the new block from the prior one with exactly one blank line", async () => {
    const dir = vault(1);
    await runLogAppend({ vault: dir, content: ENTRY });
    const text = readFileSync(join(dir, "log.md"), "utf8");
    expect(text).toContain(`- detail\n\n${ENTRY}\n`);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("empty/whitespace content -> USAGE (46), log unchanged", async () => {
    const dir = vault(2);
    const before = readFileSync(join(dir, "log.md"), "utf8");
    const r = await runLogAppend({ vault: dir, content: "   \n  " });
    expect(r.exitCode).toBe(46);
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
  });

  it("invalid vault (no SCHEMA.md) -> VAULT_PATH_INVALID (9)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "novault-"));
    const r = await runLogAppend({ vault: dir, content: ENTRY });
    expect(r.exitCode).toBe(9);
  });

  it("held fresh lock -> LOG_APPEND_LOCK_HELD (49), log unchanged", async () => {
    const dir = vault(2);
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    const held = JSON.stringify({ pid: 1, owner_token: "other-owner", acquired: new Date().toISOString() });
    writeFileSync(logLockPath(dir), held);
    const before = readFileSync(join(dir, "log.md"), "utf8");
    // A fresh lock is not stale, so acquire spins for its full budget then fails.
    const r = await runLogAppend({ vault: dir, content: ENTRY });
    expect(r.exitCode).toBe(49);
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
    expect(readFileSync(logLockPath(dir), "utf8")).toBe(held);
  });

  it("stale lock is broken and append succeeds", async () => {
    const dir = vault(2);
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    const lp = logLockPath(dir);
    writeFileSync(lp, JSON.stringify({ pid: 1, acquired: "2000-01-01T00:00:00.000Z" }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lp, old, old);
    const r = await runLogAppend({ vault: dir, content: ENTRY });
    expect(r.exitCode).toBe(0);
  });

  it("leaves no .tmp residue after a successful append", async () => {
    const dir = vault(2);
    await runLogAppend({ vault: dir, content: ENTRY });
    expect(existsSync(join(dir, "log.md.tmp"))).toBe(false);
  });

  it("releases the lock after a successful append", async () => {
    const dir = vault(2);
    await runLogAppend({ vault: dir, content: ENTRY });
    expect(existsSync(logLockPath(dir))).toBe(false);
  });

  it("deduplicates a publication operation while holding the log lock", async () => {
    const dir = vault(2);
    const input = {
      vault: dir,
      content: "## [2026-07-13] page-publish | queries/test-query.md\n\n- Published: [[queries/test-query]]",
      operationId: "a".repeat(64),
    };

    const first = await runLogAppend(input);
    const before = statSync(join(dir, "log.md")).mtimeMs;
    const second = await runLogAppend(input);

    expect(first.result).toMatchObject({ ok: true, data: { appended: true } });
    expect(second.result).toMatchObject({ ok: true, data: { appended: false } });
    expect(statSync(join(dir, "log.md")).mtimeMs).toBe(before);
    expect(readFileSync(join(dir, "log.md"), "utf8").match(/skillwiki-page-publish:/g)).toHaveLength(1);
  });

  it("rejects an invalid operation ID without changing log.md", async () => {
    const dir = vault(2);
    const before = readFileSync(join(dir, "log.md"), "utf8");

    const result = await runLogAppend({ vault: dir, content: ENTRY, operationId: "not-a-sha" });

    expect(result).toMatchObject({ exitCode: 46, result: { ok: false, error: "USAGE" } });
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
  });

  it("rejects sensitive log content without changing log.md", async () => {
    const dir = vault(2);
    const before = readFileSync(join(dir, "log.md"), "utf8");
    const content = `${ENTRY}\n\napi_key: sk-${"a".repeat(24)}`;

    const result = await runLogAppend({ vault: dir, content });

    expect(result).toMatchObject({ exitCode: 51, result: { ok: false, error: "SENSITIVE_CONTENT_DETECTED" } });
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
  });

  it("strict lock contention does not reclaim a stale lock or change log.md", async () => {
    const dir = vault(2);
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    const lock = logLockPath(dir);
    writeFileSync(lock, JSON.stringify({ pid: 1, owner_token: "other-owner", acquired: "2000-01-01T00:00:00.000Z" }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const before = readFileSync(join(dir, "log.md"), "utf8");

    const result = await runLogAppend({ vault: dir, content: ENTRY, strictLock: true });

    expect(result).toMatchObject({ exitCode: 49, result: { ok: false, error: "LOG_APPEND_LOCK_HELD" } });
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
    expect(readFileSync(lock, "utf8")).toContain("other-owner");
  });

  it("refuses a token-mismatched release without changing log.md", async () => {
    const dir = vault(2);
    const before = readFileSync(join(dir, "log.md"), "utf8");
    const acquired = await acquireLogLock(dir);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    writeFileSync(logLockPath(dir), JSON.stringify({
      owner_token: "other-owner",
      acquired: new Date().toISOString(),
    }));

    expect(releaseLogLock(acquired.data)).toMatchObject({ ok: false, error: "LOG_APPEND_LOCK_HELD" });
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
    expect(readFileSync(logLockPath(dir), "utf8")).toContain("other-owner");
  });

  it("records a legacy last-op entry by default", async () => {
    const dir = vault(2);

    const result = await runLogAppend({ vault: dir, content: ENTRY });

    expect(result.result).toMatchObject({ ok: true, data: { appended: true } });
    expect(readFileSync(join(dir, ".skillwiki", "last-op.json"), "utf8")).toContain("log-append");
  });

  it("can append an operation-marked entry without recording last-op", async () => {
    const dir = vault(2);
    const result = await runLogAppend({
      vault: dir,
      content: "## [2026-07-13] page-publish | queries/test-query.md",
      operationId: "b".repeat(64),
      recordLastOp: false,
    });

    expect(result.result).toMatchObject({ ok: true, data: { appended: true } });
    expect(readFileSync(join(dir, "log.md"), "utf8")).toContain("<!-- skillwiki-page-publish:");
    expect(existsSync(join(dir, ".skillwiki", "last-op.json"))).toBe(false);
  });
});
