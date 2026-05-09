import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { postCommit } from "../../src/utils/auto-commit.js";
import { appendLastOp } from "../../src/utils/last-op.js";

const TMP = join(process.cwd(), ".tmp-auto-commit-test");

function initTestRepo(): string {
  const repo = join(TMP, "vault");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(repo, "raw", "articles"), { recursive: true });
  mkdirSync(join(repo, ".skillwiki"), { recursive: true });
  execFileSync("git", ["init", repo], { encoding: "utf8" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@test.com"], { encoding: "utf8" });
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"], { encoding: "utf8" });
  // Initial commit so HEAD exists
  writeFileSync(join(repo, "README.md"), "# test\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { encoding: "utf8" });
  return repo;
}

function makeDotenv(autoCommit: string): string {
  const dir = join(TMP, "home", ".skillwiki");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, ".env");
  writeFileSync(p, `AUTO_COMMIT=${autoCommit}\n`, "utf8");
  return dir;
}

describe("postCommit", () => {
  const origHome = process.env.HOME;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(TMP, { recursive: true, force: true });
  });

  it("does nothing when exitCode is non-zero", async () => {
    const vault = initTestRepo();
    makeDotenv("true");
    process.env.HOME = join(TMP, "home");
    writeFileSync(join(vault, "raw", "articles", "test.md"), "content");
    appendLastOp(vault, { operation: "ingest", summary: "test", files: ["raw/articles/test.md"], timestamp: new Date().toISOString() });

    await postCommit(vault, 1);

    // Should not have committed — check last-op still exists
    const lastOpPath = join(vault, ".skillwiki", "last-op.json");
    expect(existsSync(lastOpPath)).toBe(true);
  });

  it("does nothing when AUTO_COMMIT is not true", async () => {
    const vault = initTestRepo();
    makeDotenv("false");
    process.env.HOME = join(TMP, "home");
    writeFileSync(join(vault, "raw", "articles", "test.md"), "content");
    appendLastOp(vault, { operation: "ingest", summary: "test", files: ["raw/articles/test.md"], timestamp: new Date().toISOString() });

    await postCommit(vault, 0);

    const lastOpPath = join(vault, ".skillwiki", "last-op.json");
    expect(existsSync(lastOpPath)).toBe(true);
  });

  it("commits when AUTO_COMMIT=true and last-op exists", async () => {
    const vault = initTestRepo();
    makeDotenv("true");
    process.env.HOME = join(TMP, "home");
    writeFileSync(join(vault, "raw", "articles", "test.md"), "content");
    appendLastOp(vault, { operation: "ingest", summary: "added test", files: ["raw/articles/test.md"], timestamp: new Date().toISOString() });

    await postCommit(vault, 0);

    // last-op should be cleared after commit
    const lastOpPath = join(vault, ".skillwiki", "last-op.json");
    expect(existsSync(lastOpPath)).toBe(false);

    // Check git log for the commit message
    const log = execFileSync("git", ["-C", vault, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
    expect(log).toContain("ingest: added test");
  });

  it("does nothing when last-op is empty", async () => {
    const vault = initTestRepo();
    makeDotenv("true");
    process.env.HOME = join(TMP, "home");
    writeFileSync(join(vault, "raw", "articles", "test.md"), "content");
    // No appendLastOp call

    await postCommit(vault, 0);

    // No new commit beyond init
    const log = execFileSync("git", ["-C", vault, "log", "--oneline"], { encoding: "utf8" }).trim();
    expect(log.split("\n").length).toBe(1);
  });

  it("does not throw on success", async () => {
    const vault = initTestRepo();
    makeDotenv("true");
    process.env.HOME = join(TMP, "home");
    writeFileSync(join(vault, "raw", "articles", "test.md"), "content");
    appendLastOp(vault, { operation: "ingest", summary: "test", files: ["raw/articles/test.md"], timestamp: new Date().toISOString() });

    // Should complete without throwing
    await expect(postCommit(vault, 0)).resolves.toBeUndefined();
  });
});
