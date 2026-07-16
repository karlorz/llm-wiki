import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectionsMaterialize } from "../../src/commands/projections-materialize.js";

const BIN = join(__dirname, "..", "..", "dist", "cli.js");

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", status: e.status ?? 1 };
  }
}

describe("projections materialize CLI", () => {
  it("documents --converge-vault on the help surface", () => {
    const help = runCli(["projections", "materialize", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--converge-vault <dir>");
    expect(help.stdout).toContain("Git vault used for managed pull and base-OID proof");
  });

  it("preview is read-only and does not require a convergence vault", async () => {
    const vault = mkdtempSync(join(tmpdir(), "proj-mat-preview-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(vault, "index.md"), "# Index\n");
    writeFileSync(join(vault, "log.md"), "# Log\n");
    mkdirSync(join(vault, "meta", "log-events"), { recursive: true });
    mkdirSync(join(vault, "projects"), { recursive: true });
    const beforeIndex = "# Index\n";
    const preview = await runProjectionsMaterialize({ vault, write: false, skipAuthority: true });
    expect(preview.result.ok).toBe(true);
    expect(preview.result).toMatchObject({ ok: true, data: { dry_run: true } });
    expect(readFileSync(join(vault, "index.md"), "utf8")).toBe(beforeIndex);
  });
});
