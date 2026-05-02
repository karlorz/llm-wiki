import { describe, it, expect } from "vitest";
import { CompoundSchema } from "./schemas.js";

const v = {
  title: "Async drift gotcha",
  created: "2026-05-03",
  updated: "2026-05-03",
  type: "gotcha",
  tags: ["concurrency"],
  confidence: "medium",
  project: "[[cmux]]",
  work_items: ["[[2026-04-15-bug]]"]
};

describe("CompoundSchema", () => {
  it("accepts a valid compound entry", () => {
    expect(CompoundSchema.parse(v)).toMatchObject(v);
  });
  it("requires at least one work_item", () => {
    expect(() => CompoundSchema.parse({ ...v, work_items: [] })).toThrow();
  });
  it("rejects unknown type", () => {
    expect(() => CompoundSchema.parse({ ...v, type: "trivia" })).toThrow();
  });
});
