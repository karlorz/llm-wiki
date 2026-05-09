import { describe, it, expect } from "vitest";
import { git, gitStrict } from "../../src/utils/git.js";

describe("git helpers", () => {
  it("git returns empty string on failure", () => {
    const result = git("/nonexistent/path", ["status"]);
    expect(result).toBe("");
  });

  it("gitStrict throws on failure", () => {
    expect(() => gitStrict("/nonexistent/path", ["status"])).toThrow();
  });

  it("git returns trimmed stdout on success", () => {
    const result = git(process.cwd(), ["--version"]);
    expect(result).toMatch(/^git version \d/);
  });

  it("gitStrict returns trimmed stdout on success", () => {
    const result = gitStrict(process.cwd(), ["--version"]);
    expect(result).toMatch(/^git version \d/);
  });
});
