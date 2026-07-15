import { describe, expect, it } from "vitest";
import { operationId } from "../../src/utils/operation-id.js";

describe("operationId", () => {
  it("is deterministic and 64 hex", () => {
    const a = operationId("skillwiki-page-publish-v1", ["concepts/a.md", "body", "note"]);
    const b = operationId("skillwiki-page-publish-v1", ["concepts/a.md", "body", "note"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
