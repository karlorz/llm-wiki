import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runPath } from "../../src/commands/path.js";

const CLI_BIN = join(__dirname, "..", "..", "dist", "cli.js");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_BIN, ...args], {
      encoding: "utf8",
      env: { ...process.env, AUTO_COMMIT: "false" },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      status: err.status ?? 1,
    };
  }
}

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

  it("CLI --plain prints exactly the vault path via dist/cli.js", () => {
    if (!existsSync(CLI_BIN)) {
      throw new Error(`missing built CLI at ${CLI_BIN}; run npm run build in packages/cli`);
    }
    const dir = mkdtempSync(join(tmpdir(), "vault-path-cli-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");

    const result = runCli(["path", "--vault", dir, "--plain"]);

    expect(result.status, `cli failed: ${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(`${dir}\n`);
    expect(result.stdout.trim()).toBe(dir);
    expect(result.stdout.startsWith("{")).toBe(false);
    expect(result.stdout).not.toContain("via");
    expect(result.stdout).not.toContain("ok");
  });
});
