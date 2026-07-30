import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveNameForExistingYearLog,
  runLogRotate,
} from "../../src/commands/log-rotate.js";

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

  it("archiveNameForExistingYearLog matches vault log-archive-YYYY-MM-DD-to-MM-DD convention", () => {
    const text = `# Vault Log\n\n## [2026-06-18] a\n\n## [2026-07-12] b\n`;
    expect(archiveNameForExistingYearLog(text, "2026")).toBe("log-archive-2026-06-18-to-07-12.md");
  });

  it("dry-run warns when year archive already exists", async () => {
    const dir = v(600, "2026");
    writeFileSync(
      join(dir, "log-2026.md"),
      "# Vault Log\n\n## [2026-03-01] prior | keep me\n\n- old archive body\n",
    );
    const r = await runLogRotate({ vault: dir, threshold: 500, apply: false });
    expect(r.exitCode).toBe(21);
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("sidelined");
      expect(r.result.data.humanHint).toContain("log-2026.md");
    }
    // dry-run must not mutate year archive
    expect(readFileSync(join(dir, "log-2026.md"), "utf8")).toContain("keep me");
  });

  it("apply sidelined existing log-YYYY.md instead of clobbering it", async () => {
    const dir = v(600, "2026");
    const prior = "# Vault Log\n\n## [2026-06-18] prior | unique marker ALPHA\n\n- body\n\n## [2026-07-12] prior | unique marker BETA\n\n- body\n";
    writeFileSync(join(dir, "log-2026.md"), prior);
    const originalLog = readFileSync(join(dir, "log.md"), "utf8");

    const r = await runLogRotate({ vault: dir, threshold: 500, apply: true });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    expect(r.result.data.rotated).toBe(true);
    expect(r.result.data.rotated_to).toBe("log-2026.md");
    expect(r.result.data.archived_existing_to).toBe("log-archive-2026-06-18-to-07-12.md");

    // Prior year archive content must survive under log-archive-*
    const archived = readFileSync(join(dir, "log-archive-2026-06-18-to-07-12.md"), "utf8");
    expect(archived).toBe(prior);
    expect(archived).toContain("unique marker ALPHA");

    // New year file is the former log.md contents (full preservation)
    expect(readFileSync(join(dir, "log-2026.md"), "utf8")).toBe(originalLog);

    // Fresh log.md is a short rotate header only
    const fresh = readFileSync(join(dir, "log.md"), "utf8");
    expect(fresh).toContain("Log rotated from 600 entries");
    expect(fresh).toContain("log-archive-2026-06-18-to-07-12.md");
    expect(fresh).not.toContain("unique marker ALPHA");
    for (let i = 0; i < 600; i++) {
      expect(fresh).not.toContain(`entry ${i}`);
    }

    // No other unexpected clobber: archive + year + log exist
    const names = readdirSync(dir).filter((n) => n.startsWith("log"));
    expect(names).toContain("log.md");
    expect(names).toContain("log-2026.md");
    expect(names).toContain("log-archive-2026-06-18-to-07-12.md");
  });
});
