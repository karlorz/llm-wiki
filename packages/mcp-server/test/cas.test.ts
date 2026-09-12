import { describe, expect, it } from "vitest";
import { fileChangedError } from "../src/txn.js";

describe("Tier 2 CAS error shape scaffold", () => {
  it("returns StashBase-style FILE_CHANGED with sha256 currentVersion", () => {
    expect(fileChangedError("projects/x/knowledge.md", "ab".repeat(32))).toEqual({
      error: "FILE_CHANGED",
      currentVersion: `sha256:${"ab".repeat(32)}`,
      path: "projects/x/knowledge.md",
    });
  });
});
