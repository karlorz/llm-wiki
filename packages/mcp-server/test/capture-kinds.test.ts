import { describe, expect, it } from "vitest";
import { CAPTURE_KINDS } from "../src/tools/writes.js";

describe("CAPTURE_KINDS", () => {
  it("exported list is exactly task, idea, bug, note", () => {
    expect(CAPTURE_KINDS).toEqual(["task", "idea", "bug", "note"]);
  });
});
