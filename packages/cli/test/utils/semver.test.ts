import { describe, it, expect } from "vitest";
import { semverGt } from "../../src/utils/semver.js";

describe("semverGt", () => {
  it("returns true for newer prerelease > older prerelease (same beta series)", () => {
    expect(semverGt("0.2.0-beta.16", "0.2.0-beta.15")).toBe(true);
  });

  it("returns false for older prerelease < newer prerelease", () => {
    expect(semverGt("0.2.0-beta.9", "0.2.0-beta.15")).toBe(false);
  });

  it("handles numeric prerelease ordering correctly (10 > 9)", () => {
    // This was a bug with string comparison: "beta.10" < "beta.9" lexically
    expect(semverGt("0.2.0-beta.10", "0.2.0-beta.9")).toBe(true);
    expect(semverGt("0.2.0-beta.9", "0.2.0-beta.10")).toBe(false);
  });

  it("returns true for release > prerelease", () => {
    expect(semverGt("0.2.0", "0.2.0-beta.15")).toBe(true);
  });

  it("returns false for prerelease > release", () => {
    expect(semverGt("0.2.0-beta.15", "0.2.0")).toBe(false);
  });

  it("returns true for minor bump", () => {
    expect(semverGt("0.3.0", "0.2.5")).toBe(true);
  });

  it("returns true for major bump", () => {
    expect(semverGt("1.0.0", "0.9.9")).toBe(true);
  });

  it("returns false for equal versions", () => {
    expect(semverGt("0.2.0-beta.15", "0.2.0-beta.15")).toBe(false);
    expect(semverGt("1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false when first < second", () => {
    expect(semverGt("0.2.0-beta.15", "0.2.0-beta.16")).toBe(false);
    expect(semverGt("0.1.0", "0.2.0")).toBe(false);
  });

  it("falls back to string comparison for unparseable versions", () => {
    // Edge case: invalid semver format
    expect(semverGt("invalid", "also-invalid")).toBe("invalid" > "also-invalid");
  });
});
