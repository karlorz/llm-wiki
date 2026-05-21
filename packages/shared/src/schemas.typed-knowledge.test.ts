import { describe, it, expect } from "vitest";
import { TypedKnowledgeSchema } from "./schemas.js";

const valid = {
  title: "Transformer Architecture",
  created: "2026-05-03",
  updated: "2026-05-03",
  type: "concept",
  tags: ["ml", "nlp"],
  sources: ["raw/articles/foo.md"]
};

describe("TypedKnowledgeSchema", () => {
  it("accepts a minimal valid Hermes-shaped page", () => {
    expect(TypedKnowledgeSchema.parse(valid)).toMatchObject(valid);
  });

  it("rejects when type is not in the enum", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, type: "bogus" })).toThrow();
  });

  it("rejects when sources is empty", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, sources: [] })).toThrow();
  });

  it("accepts additive fields without ignoring them", () => {
    const v = { ...valid, provenance: "project", provenance_projects: ["[[cmux]]"], aliases: ["TA"], confidence: "high" };
    expect(TypedKnowledgeSchema.parse(v).provenance).toBe("project");
  });

  it("rejects YYYY-MM-DD-shaped string with invalid month", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, created: "2026-13-01" })).toThrow();
  });

  it("requires provenance_projects when provenance != research", () => {
    expect(() => TypedKnowledgeSchema.parse({ ...valid, provenance: "project" })).toThrow();
  });

  describe("stale_ttl", () => {
    it("accepts a positive integer", () => {
      expect(TypedKnowledgeSchema.parse({ ...valid, stale_ttl: 30 }).stale_ttl).toBe(30);
    });

    it("rejects a negative integer", () => {
      expect(() => TypedKnowledgeSchema.parse({ ...valid, stale_ttl: -1 })).toThrow();
    });

    it("rejects zero", () => {
      expect(() => TypedKnowledgeSchema.parse({ ...valid, stale_ttl: 0 })).toThrow();
    });

    it("rejects a non-integer", () => {
      expect(() => TypedKnowledgeSchema.parse({ ...valid, stale_ttl: 1.5 })).toThrow();
    });

    it("rejects a string", () => {
      expect(() => TypedKnowledgeSchema.parse({ ...valid, stale_ttl: "30" as unknown as number })).toThrow();
    });

    it("defaults to undefined when omitted", () => {
      expect(TypedKnowledgeSchema.parse(valid).stale_ttl).toBeUndefined();
    });
  });
});
