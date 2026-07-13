import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogAppend } from "../../src/commands/log-append.js";
import { logLockPath } from "../../src/utils/log-lock.js";

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
});
