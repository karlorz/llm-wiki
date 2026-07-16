import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogMigrateLegacy } from "../../src/commands/log-migrate-legacy.js";

const BIN = join(__dirname, "..", "..", "dist", "cli.js");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

describe("log migrate-legacy CLI", () => {
  it("documents --converge-vault on the help surface", () => {
    const help = runCli(["log", "migrate-legacy", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--converge-vault <dir>");
    expect(help.stdout).toContain("Git vault used for managed pull and base-OID proof");
  });

  it("preview remains read-only without a convergence vault", async () => {
    const vault = mkdtempSync(join(tmpdir(), "log-mig-preview-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(vault, "log.md"), "# Vault Log\n\n## [2026-07-01] note | hello\n");
    const preview = await runLogMigrateLegacy({ vault, write: false });
    expect(preview.result.ok).toBe(true);
  });
});
