import { describe, it, expect } from "vitest";
import { parseActiveWorkPath } from "../../src/utils/work-item-path.js";

describe("parseActiveWorkPath", () => {
  it("returns project and item for the exact active work shape", () => {
    expect(parseActiveWorkPath("projects/acme/work/2026-04-01-task-x")).toEqual({
      project: "acme",
      item: "2026-04-01-task-x",
    });
    expect(parseActiveWorkPath("projects/llm-wiki/work/review-pr")).toEqual({
      project: "llm-wiki",
      item: "review-pr",
    });
  });

  it("rejects missing segments", () => {
    expect(parseActiveWorkPath("projects")).toBeUndefined();
    expect(parseActiveWorkPath("projects/acme")).toBeUndefined();
    expect(parseActiveWorkPath("projects/acme/work")).toBeUndefined();
  });

  it("rejects wrong roots", () => {
    expect(parseActiveWorkPath("raw/transcripts/2026-04-01-x.md")).toBeUndefined();
    expect(parseActiveWorkPath("concepts/alpha.md")).toBeUndefined();
    expect(parseActiveWorkPath("")).toBeUndefined();
  });

  it("rejects archive and history paths", () => {
    expect(parseActiveWorkPath("projects/acme/history/archived-work/2026-04-01-task-x")).toBeUndefined();
    expect(parseActiveWorkPath("projects/acme/history/2026-04-01-task-x")).toBeUndefined();
    expect(parseActiveWorkPath("projects/acme/work/2026-04-01-task-x/archive")).toBeUndefined();
  });

  it("rejects paths with extra segments beyond the active work shape", () => {
    expect(parseActiveWorkPath("projects/acme/work/2026-04-01-task-x/extra")).toBeUndefined();
    expect(parseActiveWorkPath("projects/acme/compound/work/2026-04-01-x")).toBeUndefined();
  });

  it("recommends archive destination root for an exact active work path", () => {
    // Regression guard for stale.ts archive planning:
    // projects/{slug}/work/{item} → projects/{slug}/history/archived-work/{item}
    const parsed = parseActiveWorkPath("projects/acme/work/2026-04-01-task-x");
    expect(parsed).toEqual({ project: "acme", item: "2026-04-01-task-x" });
  });
});
