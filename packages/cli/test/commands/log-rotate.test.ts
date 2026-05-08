import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogRotate } from "../../src/commands/log-rotate.js";

function v(entries: number, year = "2026"): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  let log = "# Vault Log\n\n";
  for (let i = 0; i < entries; i++) {
    log += `## [${year}-01-01] action | entry ${i}\n\n- detail\n\n`;
  }
  writeFileSync(join(dir, "log.md"), log);
  return dir;
}

describe("runLogRotate", () => {
  it("under threshold -> exit 0, rotated false", async () => {
    const dir = v(50);
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.rotated).toBe(false);
  });

  it("over threshold without --apply -> exit 21, no file change", async () => {
    const dir = v(600);
    const before = readFileSync(join(dir, "log.md"), "utf8");
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: false });
    expect(r.exitCode).toBe(21);
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe(before);
  });

  it("over threshold with --apply -> exit 0, log.md replaced and log-YYYY.md created", async () => {
    const dir = v(600, "2025");
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: true });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, "log-2025.md"))).toBe(true);
    const fresh = readFileSync(join(dir, "log.md"), "utf8");
    expect(fresh).toContain("# Vault Log");
    expect(fresh).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] rotate \| Log rotated from 600 entries/m);
  });

  it("second --apply on freshly rotated log is a no-op (entry count below threshold)", async () => {
    const dir = v(600, "2025");
    await runLogRotate({ vault: dir, threshold: 500, apply: true });
    const r2 = await runLogRotate({ vault: dir, threshold: 500, apply: true });
    expect(r2.exitCode).toBe(0);
    if (r2.result.ok) expect(r2.result.data.rotated).toBe(false);
  });

  it("handles small log file that doesn't need rotation", async () => {
    const dir = v(3);
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.rotated).toBe(false);
      expect(r.result.data.entries).toBe(3);
      expect(r.result.data.humanHint).toContain("no rotation needed");
    }
  });

  it("rotation preserves content — old log moved, new log has only recent header", async () => {
    const dir = v(600, "2025");
    const original = readFileSync(join(dir, "log.md"), "utf8");
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: true });
    expect(r.exitCode).toBe(0);
    // Old content should be fully preserved in the rotated file
    expect(readFileSync(join(dir, "log-2025.md"), "utf8")).toBe(original);
    // New log.md should NOT contain any of the original entries
    const fresh = readFileSync(join(dir, "log.md"), "utf8");
    for (let i = 0; i < 600; i++) {
      expect(fresh).not.toContain(`entry ${i}`);
    }
  });
});
