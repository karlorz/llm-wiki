import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLogEvent } from "../../src/utils/log-events.js";
import { runLogMaterialize } from "../../src/commands/log-materialize.js";

describe("runLogMaterialize", () => {
  it("preview is read-only; write is byte-idempotent", async () => {
    const vault = mkdtempSync(join(tmpdir(), "log-mat-"));
    writeFileSync(join(vault, "log.md"), "# Log\nold\n");
    await writeLogEvent(vault, {
      schema: "skillwiki-log-event/v1",
      operation_id: "a".repeat(64),
      occurred_at: "2026-07-15T00:00:00.000Z",
      host_id: "h",
      actor: "skillwiki-cli",
      kind: "log-entry",
      target: "log.md",
      note: "hello",
      metadata: {},
    });
    const preview = await runLogMaterialize({ vault, write: false, skipAuthority: true });
    expect(preview.result).toMatchObject({ ok: true, data: { dry_run: true, changed: true } });
    expect(readFileSync(join(vault, "log.md"), "utf8")).toContain("old");

    const first = await runLogMaterialize({ vault, write: true, skipAuthority: true });
    const firstStat = statSync(join(vault, "log.md"));
    const firstBytes = readFileSync(join(vault, "log.md"), "utf8");
    const second = await runLogMaterialize({ vault, write: true, skipAuthority: true });
    const secondStat = statSync(join(vault, "log.md"));
    expect(first.result).toMatchObject({ ok: true, data: { changed: true } });
    expect(second.result).toMatchObject({ ok: true, data: { changed: false } });
    expect(readFileSync(join(vault, "log.md"), "utf8")).toBe(firstBytes);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(firstBytes).toContain("skillwiki-log-event:");
  });
});
