import { describe, it, expect } from "vitest";
import { RawSourceSchema } from "./schemas.js";

const remote = {
  title: "Original Article",
  source_url: "https://example.com/x",
  ingested: "2026-05-03",
  ingested_by: "wiki-ingest",
  sha256: "a".repeat(64)
};

describe("RawSourceSchema", () => {
  it("accepts a remote-ingested entry", () => {
    expect(RawSourceSchema.parse(remote)).toMatchObject(remote);
  });

  it("accepts a locally originated entry (source_url null)", () => {
    expect(RawSourceSchema.parse({ ...remote, source_url: null })).toBeTruthy();
  });

  it("rejects malformed sha256", () => {
    expect(() => RawSourceSchema.parse({ ...remote, sha256: "deadbeef" })).toThrow();
  });

  it("requires project+kind when work_item is set", () => {
    expect(() => RawSourceSchema.parse({ ...remote, source_url: null, work_item: "[[2026-05-03-bug]]" })).toThrow();
  });

  it("accepts project+kind without work_item (ad-hoc capture)", () => {
    const v = {
      ...remote,
      source_url: null,
      project: "[[cmux]]",
      kind: "idea"
    };
    expect(RawSourceSchema.parse(v)).toBeTruthy();
  });

  it("accepts kind without project (standalone capture)", () => {
    const v = {
      ...remote,
      source_url: null,
      kind: "bug"
    };
    expect(RawSourceSchema.parse(v)).toBeTruthy();
  });

  it("accepts a complete project-originated entry with work_item", () => {
    const v = {
      ...remote,
      source_url: null,
      project: "[[cmux]]",
      work_item: "[[2026-05-03-bug]]",
      kind: "postmortem"
    };
    expect(RawSourceSchema.parse(v)).toBeTruthy();
  });

  it("accepts all capture kind values", () => {
    for (const kind of ["idea", "bug", "task", "note"] as const) {
      expect(RawSourceSchema.parse({ ...remote, source_url: null, kind })).toBeTruthy();
    }
  });
});
