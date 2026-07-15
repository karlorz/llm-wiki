import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { writeLogEvent, type SkillwikiLogEventV1 } from "../../src/utils/log-events.js";

describe("writeLogEvent", () => {
  it("creates, no-ops identical, collides on different bytes", async () => {
    const vault = mkdtempSync(join(tmpdir(), "log-events-"));
    const event: SkillwikiLogEventV1 = {
      schema: "skillwiki-log-event/v1",
      operation_id: "a".repeat(64),
      occurred_at: "2026-07-15T00:00:00.000Z",
      host_id: "macos-dev",
      actor: "skillwiki-cli",
      kind: "page-publish",
      target: "queries/example.md",
      note: "Published example query",
      metadata: { taxonomy_added: ["research"] },
    };
    const first = await writeLogEvent(vault, event);
    const second = await writeLogEvent(vault, event);
    expect(first).toMatchObject({
      ok: true,
      data: { created: true, path: `meta/log-events/2026-07-15/${"a".repeat(64)}.json` },
    });
    expect(second).toMatchObject({ ok: true, data: { created: false } });
    expect(await writeLogEvent(vault, { ...event, note: "different" })).toMatchObject({
      ok: false,
      error: "EVENT_IDENTITY_COLLISION",
    });
    const other: SkillwikiLogEventV1 = { ...event, operation_id: "b".repeat(64), host_id: "sg01" };
    expect(await writeLogEvent(vault, other)).toMatchObject({ ok: true, data: { created: true } });
    expect(readdirSync(join(vault, "meta", "log-events", "2026-07-15"))).toHaveLength(2);
  });
});
