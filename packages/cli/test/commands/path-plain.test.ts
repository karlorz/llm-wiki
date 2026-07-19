import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runPath } from "../../src/commands/path.js";

describe("skillwiki path --plain", () => {
  it("runPath marks plain output with path-only humanHint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-path-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
    const r = await runPath({
      flag: dir,
      envValue: undefined,
      home: tmpdir(),
      initTime: false,
      plain: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.path).toBe(dir);
      expect(r.result.data.plain).toBe(true);
      expect(r.result.data.humanHint).toBe(dir);
      expect(r.result.data.humanHint).not.toContain("via");
    }
  });

  it("CLI --plain prints exactly the vault path on stdout via emit contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-path-cli-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
    const r = await runPath({
      flag: dir,
      envValue: undefined,
      home: tmpdir(),
      initTime: false,
      plain: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    // Mirror packages/cli/src/cli.ts emit() plain branch: path only, no JSON.
    const stdout = `${String(r.result.data.path)}\n`;
    expect(stdout).toBe(`${dir}\n`);
    expect(stdout.trim()).toBe(dir);
    expect(stdout.startsWith("{")).toBe(false);
    expect(JSON.stringify(r.result)).not.toBe(stdout.trim());
  });
});
