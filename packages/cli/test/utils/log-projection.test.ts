import { describe, expect, it } from "vitest";
import { renderLogProjection } from "../../src/utils/log-projection.js";
import type { SkillwikiLogEventV1 } from "../../src/utils/log-events.js";

const base = (partial: Partial<SkillwikiLogEventV1>): SkillwikiLogEventV1 => ({
  schema: "skillwiki-log-event/v1",
  operation_id: "a".repeat(64),
  occurred_at: "2026-07-15T00:00:00.000Z",
  host_id: "h",
  actor: "skillwiki-cli",
  kind: "page-publish",
  target: "concepts/a.md",
  note: "n",
  metadata: {},
  ...partial,
});

describe("renderLogProjection", () => {
  it("orders by occurred_at then operation_id and preserves unknown kinds", () => {
    const eventA = base({
      operation_id: "a".repeat(64),
      occurred_at: "2026-07-15T00:00:00.000Z",
      kind: "page-publish",
      target: "concepts/a.md",
      metadata: { taxonomy_added: [] },
    });
    const eventB = base({
      operation_id: "c".repeat(64),
      occurred_at: "2026-07-15T01:00:00.000Z",
      target: "concepts/b.md",
    });
    const unknown = base({
      operation_id: "b".repeat(64),
      occurred_at: "2026-07-15T00:30:00.000Z",
      kind: "future-kind",
      target: "meta/future.json",
    });
    const sessionBrief = base({
      operation_id: "d".repeat(64),
      occurred_at: "2026-07-16T00:00:00.000Z",
      kind: "session-brief",
      target: "meta/latest-session-brief.md",
    });
    const text = renderLogProjection([eventB, unknown, eventA, sessionBrief]);
    expect(text.indexOf(eventA.operation_id)).toBeLessThan(text.indexOf(eventB.operation_id));
    expect(text).toContain("## [2026-07-15] future-kind | meta/future.json");
    expect(text).toContain("- Event kind: future-kind");
    expect(text).toContain(`<!-- skillwiki-log-event:${unknown.operation_id} -->`);
  });
});
