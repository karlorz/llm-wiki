import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentMemoryTrendsDaily } from "../src/jobs/agent-memory-trends-daily.js";
import type { CommandRunResult } from "../src/types.js";

describe("runAgentMemoryTrendsDaily", () => {
  it("runs generation-only daily inside one maintenance-owned commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-trends-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const before = git(vault, "rev-parse", "HEAD");
    const calls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];

    const check = await runAgentMemoryTrendsDaily({
      vaultPath: vault,
      repoPath: repo,
      project: "llm-wiki",
      runCommand: async (command, args, options) => {
        if (command === "git") return runGit(args, options.cwd);
        if (command !== "agent-memory-trends") return result("", 127, `unexpected command: ${command}`);
        calls.push({ args, cwd: options.cwd, env: options.env });
        writeGeneratedTrendOutputs(vault);
        return result(JSON.stringify({
          ok: true,
          data: {
            mutations: [
              ".skillwiki/agent-memory-trends/2026-06-13-run.json",
              ".skillwiki/agent-memory-trends/latest-run.json",
              "queries/2026-06-13-agent-memory-trends-digest.md",
              "raw/articles/2026-06-13-agent-memory-trends-evidence-2026-06-13T00.md",
              "raw/transcripts/2026-06-13-task-evaluate-agent-memory.md",
            ],
            humanHint: "daily: ok (generate-only); selected 1 candidate(s)",
          },
        }) + "\n");
      },
    });

    expect(check.status).toBe("pass");
    expect(check.details.committed).toBe(true);
    expect(check.details.changedFiles).toEqual([
      ".skillwiki/agent-memory-trends/2026-06-13-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
      "queries/2026-06-13-agent-memory-trends-digest.md",
      "raw/articles/2026-06-13-agent-memory-trends-evidence-2026-06-13T00.md",
      "raw/transcripts/2026-06-13-task-evaluate-agent-memory.md",
    ]);
    expect(git(vault, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("research(agent-memory): daily digest");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "daily",
      "--generate-only",
      "--vault",
      vault,
      "--repo",
      repo,
      "--project",
      "llm-wiki",
      "--config",
      join(vault, "projects", "llm-wiki", "architecture", "agent-memory-research-sources.yaml"),
    ]);
    expect(calls[0]?.cwd).toBe(repo);
    expect(calls[0]?.env?.AGENT_MEMORY_TRENDS_VAULT).toBe(vault);
    expect(calls[0]?.env?.AGENT_MEMORY_TRENDS_REPO).toBe(repo);
  });

  it("honors AGENT_MEMORY_TRENDS_CONFIG for controlled research runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-trends-config-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const customConfig = join(root, "real-candidate-config.yaml");
    writeFileSync(customConfig, "version: 1\n", "utf8");
    const calls: Array<{ args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
    const previousConfig = process.env.AGENT_MEMORY_TRENDS_CONFIG;
    process.env.AGENT_MEMORY_TRENDS_CONFIG = customConfig;
    try {
      const check = await runAgentMemoryTrendsDaily({
        vaultPath: vault,
        repoPath: repo,
        project: "llm-wiki",
        runCommand: async (command, args, options) => {
          if (command === "git") return runGit(args, options.cwd);
          if (command !== "agent-memory-trends") return result("", 127, `unexpected command: ${command}`);
          calls.push({ args, cwd: options.cwd, env: options.env });
          writeGeneratedTrendOutputs(vault);
          return result(JSON.stringify({
            ok: true,
            data: {
              mutations: [
                ".skillwiki/agent-memory-trends/2026-06-13-run.json",
                ".skillwiki/agent-memory-trends/latest-run.json",
              ],
              humanHint: "daily: ok (generate-only); selected 1 candidate(s)",
            },
          }) + "\n");
        },
      });

      expect(check.status).toBe("pass");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args).toContain("--config");
      expect(calls[0]?.args.at(calls[0].args.indexOf("--config") + 1)).toBe(customConfig);
      expect(calls[0]?.env?.AGENT_MEMORY_TRENDS_CONFIG).toBe(customConfig);
    } finally {
      if (previousConfig === undefined) {
        delete process.env.AGENT_MEMORY_TRENDS_CONFIG;
      } else {
        process.env.AGENT_MEMORY_TRENDS_CONFIG = previousConfig;
      }
    }
  });

  it("parses the final JSON envelope when the package build writes logs first", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-trends-logs-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));

    const check = await runAgentMemoryTrendsDaily({
      vaultPath: vault,
      repoPath: repo,
      project: "llm-wiki",
      runCommand: async (command, args, options) => {
        if (command === "git") return runGit(args, options.cwd);
        if (command !== "agent-memory-trends") return result("", 127, `unexpected command: ${command}`);
        writeGeneratedTrendOutputs(vault);
        return result([
          'CLI Building entry: {"cli":"src/cli.ts"}',
          "ESM Build start",
          "ESM dist/cli.js 120.76 KB",
          JSON.stringify({
            ok: true,
            data: {
              mutations: [
                ".skillwiki/agent-memory-trends/2026-06-13-run.json",
                ".skillwiki/agent-memory-trends/latest-run.json",
                "queries/2026-06-13-agent-memory-trends-digest.md",
              ],
              humanHint: "daily: ok (generate-only); selected 1 candidate(s)",
            },
          }),
        ].join("\n") + "\n");
      },
    });

    expect(check.status).toBe("pass");
    expect(check.details.committed).toBe(true);
    expect(check.details.jobData?.humanHint).toBe("daily: ok (generate-only); selected 1 candidate(s)");
  });

  it("rejects generated changes outside the trends allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-trends-bad-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const before = git(vault, "rev-parse", "HEAD");

    const check = await runAgentMemoryTrendsDaily({
      vaultPath: vault,
      repoPath: repo,
      project: "llm-wiki",
      runCommand: async (command, args, options) => {
        if (command === "git") return runGit(args, options.cwd);
        writeFileSync(join(vault, "concepts", "unexpected.md"), "# Bad\n", "utf8");
        return result(JSON.stringify({ ok: true, data: { mutations: ["concepts/unexpected.md"] } }) + "\n");
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toContain("outside allowlist");
    expect(check.details.allowlistViolations).toEqual(["concepts/unexpected.md"]);
    expect(git(vault, "rev-parse", "HEAD")).toBe(before);
  });

  it("preserves failed agent-memory-trends stdout and stderr after cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-trends-fail-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));

    const check = await runAgentMemoryTrendsDaily({
      vaultPath: vault,
      repoPath: repo,
      project: "llm-wiki",
      runCommand: async (command, args, options) => {
        if (command === "git") return runGit(args, options.cwd);
        if (command !== "agent-memory-trends") return result("", 127, `unexpected command: ${command}`);
        return result(
          JSON.stringify({ ok: false, error: "AGENT_FAILED", detail: "provider unavailable" }) + "\n",
          1,
          "codex exec failed\n"
        );
      },
    });

    expect(check.status).toBe("fail");
    expect(check.reason).toBe("writing job failed before commit");
    expect(check.details.jobError).toEqual({
      ok: false,
      error: "AGENT_MEMORY_TRENDS_DAILY_FAILED",
      detail: {
        stdout: JSON.stringify({ ok: false, error: "AGENT_FAILED", detail: "provider unavailable" }) + "\n",
        stderr: "codex exec failed\n",
      },
    });
    expect(git(vault, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});

function createSyncedRepo(origin: string, repo: string): string {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  git(repo, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(repo, "config", "user.name", "SkillWiki Maintenance Test");
  writeFileSync(join(repo, "package.json"), "{\"version\":\"0.8.10\"}\n", "utf8");
  git(repo, "add", "package.json");
  git(repo, "commit", "-m", "initial");
  git(repo, "branch", "-M", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  return repo;
}

function createSyncedVault(origin: string, vault: string): string {
  mkdirSync(vault, { recursive: true });
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: vault, stdio: "ignore" });
  git(vault, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(vault, "config", "user.name", "SkillWiki Maintenance Test");
  mkdirSync(join(vault, ".skillwiki", "agent-memory-trends"), { recursive: true });
  mkdirSync(join(vault, "concepts"), { recursive: true });
  mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
  writeFileSync(join(vault, "README.md"), "# Test vault\n", "utf8");
  writeFileSync(join(vault, "projects", "llm-wiki", "architecture", "agent-memory-research-sources.yaml"), "version: 1\n", "utf8");
  git(vault, "add", "README.md", "projects/llm-wiki/architecture/agent-memory-research-sources.yaml");
  git(vault, "commit", "-m", "initial");
  git(vault, "branch", "-M", "main");
  git(vault, "remote", "add", "origin", origin);
  git(vault, "push", "-u", "origin", "main");
  return vault;
}

function writeGeneratedTrendOutputs(vault: string): void {
  mkdirSync(join(vault, ".skillwiki", "agent-memory-trends"), { recursive: true });
  mkdirSync(join(vault, "queries"), { recursive: true });
  mkdirSync(join(vault, "raw", "articles"), { recursive: true });
  mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
  writeFileSync(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-13-run.json"), "{}\n", "utf8");
  writeFileSync(join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json"), "{}\n", "utf8");
  writeFileSync(join(vault, "queries", "2026-06-13-agent-memory-trends-digest.md"), "# Digest\n", "utf8");
  writeFileSync(join(vault, "raw", "articles", "2026-06-13-agent-memory-trends-evidence-2026-06-13T00.md"), "# Evidence\n", "utf8");
  writeFileSync(join(vault, "raw", "transcripts", "2026-06-13-task-evaluate-agent-memory.md"), "# Task\n", "utf8");
}

function runGit(args: string[], cwd: string): CommandRunResult {
  try {
    return result(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const typed = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return result(String(typed.stdout ?? ""), typed.status ?? 1, String(typed.stderr ?? ""));
  }
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function result(stdout = "", exitCode = 0, stderr = ""): CommandRunResult {
  return { exitCode, stdout, stderr };
}
