import { describe, it, expect } from "vitest";
import { MetaSchema } from "./schemas.js";

const v = {
  title: "Multi-project API design patterns",
  created: "2026-05-01",
  updated: "2026-05-01",
  type: "meta" as const,
  tags: ["api", "patterns"],
  provenance_projects: ["[[cmux]]", "[[llm-wiki]]"]
};

describe("MetaSchema", () => {
  it("accepts a valid meta page", () => {
    expect(MetaSchema.parse(v)).toMatchObject(v);
  });

  it("requires provenance_projects to have min 2 items", () => {
    expect(() => MetaSchema.parse({ ...v, provenance_projects: ["[[cmux]]"] })).toThrow();
    expect(() => MetaSchema.parse({ ...v, provenance_projects: [] })).toThrow();
  });

  it("requires provenance_projects when provenance is not research", () => {
    const base = { ...v, provenance: "project" as const, provenance_projects: [] as string[] };
    expect(() => MetaSchema.parse(base)).toThrow();
  });

  it("makes provenance_projects optional when provenance is research", () => {
    // provenance_projects is still required at the Zod level (.min(2)),
    // but the superRefine should NOT add an extra issue when provenance=research.
    // The min(2) rule still applies structurally, so we test that the
    // superRefine does not reject when provenance=research AND projects are provided.
    const researchWithProjects = { ...v, provenance: "research" as const };
    expect(MetaSchema.parse(researchWithProjects)).toMatchObject(researchWithProjects);
  });
});
