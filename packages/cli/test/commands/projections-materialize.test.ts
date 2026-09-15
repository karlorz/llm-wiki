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
    expect(help.stdout).toContain("--events-from <dir>");
  });

  it("preview is read-only and does not require a convergence vault", async () => {
    const vault = mkdtempSync(join(tmpdir(), "proj-mat-preview-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(vault, "index.md"), "# Index\n");
    writeFileSync(join(vault, "log.md"), "# Log\n");
    mkdirSync(join(vault, "meta", "log-events"), { recursive: true });
    mkdirSync(join(vault, "projects"), { recursive: true });
    const beforeIndex = "# Index\n";
    const preview = await runProjectionsMaterialize({ vault, write: false });
    expect(preview.result.ok).toBe(true);
    expect(preview.result).toMatchObject({ ok: true, data: { dry_run: true } });
    expect(readFileSync(join(vault, "index.md"), "utf8")).toBe(beforeIndex);
  });

  it("fails when --events-from is missing", async () => {
    const vault = mkdtempSync(join(tmpdir(), "proj-mat-missing-events-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    mkdirSync(join(vault, "projects"), { recursive: true });
    const missing = join(vault, "no-such-events");
    const r = await runProjectionsMaterialize({ vault, write: false, eventsFrom: missing });
    expect(r.result.ok).toBe(false);
  });

  it("dry-run log_drift follows --events-from, not the vault tree", async () => {
    const { writeLogEvent, canonicalEventJson } = await import("../../src/utils/log-events.js");
    const { renderLogProjection } = await import("../../src/utils/log-projection.js");
    const vault = mkdtempSync(join(tmpdir(), "proj-mat-events-from-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(vault, "index.md"), "# Index\n");
    mkdirSync(join(vault, "projects"), { recursive: true });
    const event = {
      schema: "skillwiki-log-event/v1" as const,
      operation_id: "c".repeat(64),
      occurred_at: "2026-09-14T00:00:00.000Z",
      host_id: "macos-dev",
      actor: "skillwiki-cli",
      kind: "log-append",
      target: "log.md",
      note: "mcp log-append",
      metadata: { appended_markdown: "## [2026-09-14] note | test" },
    };
    await writeLogEvent(vault, event);
    const extra = { ...event, operation_id: "d".repeat(64), note: "extra fuse event" };
    await writeLogEvent(vault, extra);
    const eventsFrom = mkdtempSync(join(tmpdir(), "s3-log-events-"));
    const dayDir = join(eventsFrom, "2026-09-14");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, `${"c".repeat(64)}.json`), canonicalEventJson(event));
    const logText = renderLogProjection([event]);
    writeFileSync(join(vault, "log.md"), logText);

    const fromS3 = await runProjectionsMaterialize({ vault, write: false, eventsFrom });
    expect(fromS3.result.ok).toBe(true);
    if (fromS3.result.ok) expect(fromS3.result.data.log_drift).toBe(false);

    const fromVault = await runProjectionsMaterialize({ vault, write: false });
    expect(fromVault.result.ok).toBe(true);
    if (fromVault.result.ok) expect(fromVault.result.data.log_drift).toBe(true);
  });
});
