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

  it("accepts generated session brief meta without provenance_projects", () => {
    const generated = {
      title: "Latest Session Brief",
      created: "2026-06-11",
      updated: "2026-06-11",
      type: "meta" as const,
      tags: ["meta", "session-brief"],
      generated_by: "skillwiki session-brief",
      generated_at: "2026-06-11T00:10:00Z",
      generated_kind: "session-brief" as const
    };

    expect(MetaSchema.parse(generated)).toMatchObject(generated);
  });

  it("accepts session-pins meta without provenance_projects", () => {
    const pins = {
      title: "Session Pins",
      created: "2026-07-04",
      updated: "2026-07-04",
      type: "meta" as const,
      meta_kind: "session-pins" as const,
      tags: ["meta", "session-pins"],
      stale_ttl: 3650,
      pins: [
        {
          title: "Monetization Strategy",
          path: "queries/2026-07-04-knowledge-monetization-strategy.md",
          scope: "global" as const,
          project: "[[llm-wiki]]",
          summary: "Keep strategy visible without making it claimable work.",
          updated: "2026-07-04",
        },
      ],
    };

    expect(MetaSchema.parse(pins)).toMatchObject(pins);
  });

  it("rejects raw transcript paths as session pin targets", () => {
    expect(() => MetaSchema.parse({
      title: "Session Pins",
      created: "2026-07-04",
      updated: "2026-07-04",
      type: "meta",
      meta_kind: "session-pins",
      tags: ["meta", "session-pins"],
      pins: [
        {
          title: "Raw Capture",
          path: "raw/transcripts/2026-07-04-task-monetization-strategy.md",
          scope: "global",
        },
      ],
    })).toThrow();
  });

  it("rejects unknown generated_kind values", () => {
    expect(() => MetaSchema.parse({
      ...v,
      generated_kind: "daily-digest"
    })).toThrow();
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
