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

  it("renders log-append from appended_markdown plus event marker", () => {
    const event = base({
      operation_id: "e".repeat(64),
      occurred_at: "2026-09-14T00:00:00.000Z",
      actor: "skillwiki-mcp",
      kind: "log-append",
      target: "log.md",
      note: "mcp append",
      metadata: { appended_markdown: "## [2026-09-14] capture | note: canary-line" },
    });
    const text = renderLogProjection([event]);
    expect(text).toContain("## [2026-09-14] capture | note: canary-line");
    expect(text).toContain(`<!-- skillwiki-log-event:${event.operation_id} -->`);
    expect(text).not.toContain("- Event kind: log-append");
    expect(text).not.toContain("appended_markdown");
  });

  it("orders same-day day-bucketed events by operation_id", () => {
    const laterId = base({
      operation_id: "f".repeat(64),
      occurred_at: "2026-09-14T00:00:00.000Z",
      kind: "log-append",
      target: "log.md",
      metadata: { appended_markdown: "## [2026-09-14] second" },
    });
    const earlierId = base({
      operation_id: "e".repeat(64),
      occurred_at: "2026-09-14T00:00:00.000Z",
      kind: "log-append",
      target: "log.md",
      metadata: { appended_markdown: "## [2026-09-14] first" },
    });
    const text = renderLogProjection([laterId, earlierId]);
    expect(text.indexOf("## [2026-09-14] first")).toBeLessThan(text.indexOf("## [2026-09-14] second"));
  });
});
