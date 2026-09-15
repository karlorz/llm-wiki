import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("git honors an optional timeout", () => {
    const result = git(process.cwd(), ["--version"], { timeoutMs: 3000 });
    expect(result).toMatch(/^git version \d/);
  });

  it("git returns output larger than Node's default subprocess buffer", () => {
    const repo = mkdtempSync(join(tmpdir(), "git-helper-large-output-"));
    const content = "x".repeat(1_100_000);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "large.txt"), content);
    execFileSync("git", ["-C", repo, "add", "large.txt"]);

    expect(git(repo, ["show", ":large.txt"])).toBe(content);
  });

  it("gitStrict returns trimmed stdout on success", () => {
    const result = gitStrict(process.cwd(), ["--version"]);
    expect(result).toMatch(/^git version \d/);
  });
});
