import { describe, it, expect } from "vitest";
import { getErrorMessage } from "./error-message.js";

describe("getErrorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("converts non-Error throws to string", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
    expect(getErrorMessage(42)).toBe("42");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("handles objects with toString", () => {
    expect(getErrorMessage({ toString() { return "custom"; } })).toBe("custom");
  });
});
