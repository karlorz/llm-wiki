import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRunner } from "../src/command.js";
import { runWriteTransaction } from "../src/write-transaction.js";

describe("runWriteTransaction", () => {
  it("commits exactly one allowed write job change", async () => {
    const repo = createSyncedRepo();
    const before = git(repo, "rev-parse", "HEAD");

    const check = await runWriteTransaction({
      job: "health-summary",
      repoPath: repo,
      allowlist: ["reports/**"],
      commitMessage: "chore(maintenance): update health summary",
      runCommand: createCommandRunner(),
      run: async () => {
        mkdirSync(join(repo, "reports"), { recursive: true });
        writeFileSync(join(repo, "reports", "health.md"), "# Health\n\nOK\n", "utf8");
        return { ok: true, data: { rows: 1 } };
      },
    });

    expect(check.status).toBe("pass");
    expect(check.details.committed).toBe(true);
    expect(check.details.changedFiles).toEqual(["reports/health.md"]);
    expect(git(repo, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("chore(maintenance): update health summary");
  });

  it("rejects changes outside the job allowlist without committing", async () => {
    const repo = createSyncedRepo();
    const before = git(repo, "rev-parse", "HEAD");

    const check = await runWriteTransaction({
      job: "session-brief-refresh",
      repoPath: repo,
      allowlist: ["meta/latest-session-brief.md"],
      commitMessage: "chore(maintenance): refresh session brief",
      runCommand: createCommandRunner(),
      run: async () => {
        mkdirSync(join(repo, "meta"), { recursive: true });
        writeFileSync(join(repo, "meta", "latest-session-brief.md"), "# Brief\n", "utf8");
        writeFileSync(join(repo, "log.md"), "unexpected\n", "utf8");
        return { ok: true, data: {} };
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("outside allowlist");
    expect(check.details.committed).toBe(false);
    expect(check.details.allowlistViolations).toEqual(["log.md"]);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("supports bounded filename globs in write allowlists", async () => {
    const repo = createSyncedRepo();

    const check = await runWriteTransaction({
      job: "agent-memory-trends-daily",
      repoPath: repo,
      allowlist: [
        ".skillwiki/agent-memory-trends/**",
        "queries/*-agent-memory-trends-digest.md",
        "raw/articles/*-agent-memory-trends-evidence*.md",
      ],
      commitMessage: "research(agent-memory): daily digest",
      runCommand: createCommandRunner(),
      run: async () => {
        mkdirSync(join(repo, ".skillwiki", "agent-memory-trends"), { recursive: true });
        mkdirSync(join(repo, "queries"), { recursive: true });
        mkdirSync(join(repo, "raw", "articles"), { recursive: true });
        writeFileSync(join(repo, ".skillwiki", "agent-memory-trends", "2026-06-13-run.json"), "{}\n", "utf8");
        writeFileSync(join(repo, "queries", "2026-06-13-agent-memory-trends-digest.md"), "# Digest\n", "utf8");
        writeFileSync(join(repo, "raw", "articles", "2026-06-13-agent-memory-trends-evidence-2026-06-13T00.md"), "# Evidence\n", "utf8");
        return { ok: true, data: {} };
      },
    });

    expect(check.status).toBe("pass");
    expect(check.details.changedFiles).toEqual([
      ".skillwiki/agent-memory-trends/2026-06-13-run.json",
      "queries/2026-06-13-agent-memory-trends-digest.md",
      "raw/articles/2026-06-13-agent-memory-trends-evidence-2026-06-13T00.md",
    ]);
  });

  it("refuses to run a writing job when the repo starts dirty", async () => {
    const repo = createSyncedRepo();
    let called = false;
    writeFileSync(join(repo, "dirty.md"), "existing dirty state\n", "utf8");

    const check = await runWriteTransaction({
      job: "agent-memory-trends-daily",
      repoPath: repo,
      allowlist: ["raw/transcripts/**"],
      commitMessage: "chore(maintenance): run trends daily",
      runCommand: createCommandRunner(),
      run: async () => {
        called = true;
        return { ok: true, data: {} };
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("repo is dirty before job");
    expect(check.details.changedFiles).toEqual(["dirty.md"]);
    expect(called).toBe(false);
  });

  it("cleans allowed generated changes when a writing job fails before commit", async () => {
    const repo = createSyncedRepo();
    mkdirSync(join(repo, ".skillwiki", "agent-memory-trends"), { recursive: true });
    writeFileSync(join(repo, ".skillwiki", "agent-memory-trends", "latest-run.json"), "{\"status\":\"previous\"}\n", "utf8");
    git(repo, "add", ".skillwiki/agent-memory-trends/latest-run.json");
    git(repo, "commit", "-m", "seed tracked trend metadata");
    git(repo, "push", "origin", "main");
    const before = git(repo, "rev-parse", "HEAD");

    const check = await runWriteTransaction({
      job: "agent-memory-trends-daily",
      repoPath: repo,
      allowlist: [
        ".skillwiki/agent-memory-trends/**",
        "queries/*-agent-memory-trends-digest.md",
        "raw/articles/*-agent-memory-trends-evidence*.md",
      ],
      commitMessage: "research(agent-memory): daily digest",
      runCommand: createCommandRunner(),
      run: async () => {
        mkdirSync(join(repo, "queries"), { recursive: true });
        mkdirSync(join(repo, "raw", "articles"), { recursive: true });
        writeFileSync(join(repo, ".skillwiki", "agent-memory-trends", "latest-run.json"), "{\"status\":\"failed\"}\n", "utf8");
        writeFileSync(join(repo, "queries", "2026-06-19-agent-memory-trends-digest.md"), "# Digest\n", "utf8");
        writeFileSync(
          join(repo, "raw", "articles", "2026-06-19-agent-memory-trends-evidence-2026-06-19T03-40-39+08-00.md"),
          "# Evidence\n",
          "utf8"
        );
        return { ok: false, error: "TREND_GENERATION_FAILED" };
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("cleaned allowed changes");
    expect(check.details.committed).toBe(false);
    expect(check.details.changedFiles).toEqual([
      ".skillwiki/agent-memory-trends/latest-run.json",
      "queries/2026-06-19-agent-memory-trends-digest.md",
      "raw/articles/2026-06-19-agent-memory-trends-evidence-2026-06-19T03-40-39+08-00.md",
    ]);
    expect(check.details.jobError).toEqual({ ok: false, error: "TREND_GENERATION_FAILED" });
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses to run a writing job when origin/main is ahead", async () => {
    const repo = createSyncedRepo();
    const sibling = join(repo, "..", "sibling");
    git(repo, "clone", join(repo, "..", "origin.git"), sibling);
    git(sibling, "checkout", "-B", "main", "origin/main");
    git(sibling, "config", "user.email", "skillwiki-maintenance@example.invalid");
    git(sibling, "config", "user.name", "SkillWiki Maintenance Test");
    writeFileSync(join(sibling, "remote.md"), "remote change\n", "utf8");
    git(sibling, "add", "remote.md");
    git(sibling, "commit", "-m", "remote change");
    git(sibling, "push", "origin", "main");

    let called = false;
    const check = await runWriteTransaction({
      job: "health-summary",
      repoPath: repo,
      allowlist: ["reports/**"],
      commitMessage: "chore(maintenance): update health summary",
      runCommand: createCommandRunner(),
      run: async () => {
        called = true;
        return { ok: true, data: {} };
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("not synchronized");
    expect(check.details.behind).toBe(1);
    expect(called).toBe(false);
  });

  it("passes without committing when a writing job produces no changes", async () => {
    const repo = createSyncedRepo();
    const before = git(repo, "rev-parse", "HEAD");

    const check = await runWriteTransaction({
      job: "health-summary",
      repoPath: repo,
      allowlist: ["reports/**"],
      commitMessage: "chore(maintenance): update health summary",
      runCommand: createCommandRunner(),
      run: async () => ({ ok: true, data: { rows: 0 } }),
    });

    expect(check.status).toBe("pass");
    expect(check.reason).toContain("no changes");
    expect(check.details.committed).toBe(false);
    expect(check.details.changedFiles).toEqual([]);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });
});

function createSyncedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-tx-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  mkdirSync(repo);

  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  git(repo, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(repo, "config", "user.name", "SkillWiki Maintenance Test");
  writeFileSync(join(repo, "README.md"), "# Test vault\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "branch", "-M", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");

  return repo;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
