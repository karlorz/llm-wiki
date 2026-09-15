import { describe, expect, it } from "vitest";
import { MAX_READ_PAGE_BYTES } from "../src/tools/reads.js";

describe("MAX_READ_PAGE_BYTES", () => {
  it("exact value is 262144", () => {
    expect(MAX_READ_PAGE_BYTES).toBe(262144);
  });
});
