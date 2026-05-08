import { describe, it, expect } from "vitest";
import { detectSchema } from "./schemas.js";

describe("detectSchema", () => {
  it("detects typed-knowledge by `type` enum + `sources`", () => {
    expect(detectSchema({ type: "concept", sources: ["x"] }).schema).toBe("typed-knowledge");
  });
  it("detects raw by `sha256` + `ingested`", () => {
    expect(detectSchema({ sha256: "a".repeat(64), ingested: "2026-05-03" }).schema).toBe("raw");
  });
  it("detects work item by `kind` + `status`", () => {
    expect(detectSchema({ kind: "feature", status: "planned" }).schema).toBe("work-item");
  });
  it("detects compound by `type` lesson/pattern + `project`", () => {
    expect(detectSchema({ type: "lesson", project: "[[x]]" }).schema).toBe("compound");
  });
  it("returns null for unknown shapes", () => {
    expect(detectSchema({ random: 1 }).schema).toBe(null);
  });
  it("detects meta by `type: 'meta'`", () => {
    expect(detectSchema({ type: "meta", tags: ["x"] }).schema).toBe("meta");
  });
  it("does not confuse meta with typed-knowledge (no sources)", () => {
    expect(detectSchema({ type: "meta", tags: ["x"] }).schema).toBe("meta");
  });
});
