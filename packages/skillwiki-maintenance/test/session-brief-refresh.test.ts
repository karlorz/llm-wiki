import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSessionBriefRefresh } from "../src/jobs/session-brief-refresh.js";
import type { CommandRunResult } from "../src/types.js";

describe("runSessionBriefRefresh", () => {
  it("refreshes session brief files inside one maintenance-owned commit", async () => {
    const vault = createSyncedVault();
    const before = git(vault, "rev-parse", "HEAD");
    const skillwikiCalls: Array<{ args: string[]; cwd: string; home?: string; envBody?: string }> = [];

    const check = await runSessionBriefRefresh({
      vaultPath: vault,
      repoPath: "/home/agent-memory/llm-wiki",
      project: "llm-wiki",
      runCommand: async (command, args, options) => {
        if (command === "git") return runGit(args, options.cwd);
        if (command !== "skillwiki") return result("", 127, `unexpected command: ${command}`);
        const home = options.env?.HOME;
        skillwikiCalls.push({
          args,
          cwd: options.cwd,
          home,
          envBody: home ? readFileSync(join(home, ".skillwiki", ".env"), "utf8") : undefined,
        });
        writeSessionBriefOutputs(vault);
        return result(JSON.stringify({ ok: true }) + "\n");
      },
    });

    expect(check.status).toBe("pass");
    expect(check.details.committed).toBe(true);
    expect(check.details.changedFiles).toEqual([
      ".skillwiki/session-brief.json",
      ".skillwiki/session-brief.md",
      "index.md",
      "log.md",
      "meta/latest-session-brief.md",
    ]);
    expect(git(vault, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("chore(maintenance): refresh session brief");
    expect(existsSync(join(vault, ".skillwiki", "last-op.json"))).toBe(false);
    expect(skillwikiCalls).toHaveLength(1);
    expect(skillwikiCalls[0]?.args).toEqual(["session-brief", vault, "--project", "llm-wiki", "--write"]);
    expect(skillwikiCalls[0]?.cwd).toBe("/home/agent-memory/llm-wiki");
    expect(skillwikiCalls[0]?.envBody).toContain("AUTO_COMMIT=false");
    expect(existsSync(skillwikiCalls[0]!.home!)).toBe(false);
  });

  it("restores a pre-existing last-op snapshot after refreshing", async () => {
    const vault = createSyncedVault();
    const lastOpPath = join(vault, ".skillwiki", "last-op.json");
    const previousLastOp = "[{\"operation\":\"preexisting\",\"summary\":\"keep\",\"files\":[],\"timestamp\":\"2026-06-13T00:00:00Z\"}]";
    writeFileSync(lastOpPath, previousLastOp, "utf8");
    git(vault, "add", ".skillwiki/last-op.json");
    git(vault, "commit", "-m", "seed last-op");
    git(vault, "push", "origin", "main");

    const check = await runSessionBriefRefresh({
      vaultPath: vault,
      repoPath: "/repo",
      project: "llm-wiki",
      runCommand: async (command, args, options) => {
        if (command === "git") return runGit(args, options.cwd);
        writeSessionBriefOutputs(vault);
        return result();
      },
    });

    expect(check.status).toBe("pass");
    expect(readFileSync(lastOpPath, "utf8")).toBe(previousLastOp);
  });
});

function createSyncedVault(): string {
  const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-brief-"));
  const origin = join(root, "origin.git");
  const vault = join(root, "vault");
  mkdirSync(vault);

  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: vault, stdio: "ignore" });
  git(vault, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(vault, "config", "user.name", "SkillWiki Maintenance Test");
  mkdirSync(join(vault, "meta"), { recursive: true });
  mkdirSync(join(vault, ".skillwiki"), { recursive: true });
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Meta\n", "utf8");
  writeFileSync(join(vault, "log.md"), "# Log\n", "utf8");
  git(vault, "add", "index.md", "log.md");
  git(vault, "commit", "-m", "initial");
  git(vault, "branch", "-M", "main");
  git(vault, "remote", "add", "origin", origin);
  git(vault, "push", "-u", "origin", "main");

  return vault;
}

function writeSessionBriefOutputs(vault: string): void {
  mkdirSync(join(vault, "meta"), { recursive: true });
  mkdirSync(join(vault, ".skillwiki"), { recursive: true });
  writeFileSync(join(vault, "meta", "latest-session-brief.md"), "---\ntitle: Latest Session Brief\n---\n\n# Session Brief\n", "utf8");
  writeFileSync(join(vault, ".skillwiki", "session-brief.md"), "# Session Brief\n", "utf8");
  writeFileSync(join(vault, ".skillwiki", "session-brief.json"), "{\"generated_at\":\"2026-06-13T00:00:00Z\"}\n", "utf8");
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Meta\n- [[meta/latest-session-brief]] — Latest Session Brief\n", "utf8");
  writeFileSync(join(vault, "log.md"), "# Log\n\n## [2026-06-13] session-brief | refreshed: meta/latest-session-brief.md\n", "utf8");
  writeFileSync(join(vault, ".skillwiki", "last-op.json"), "[]", "utf8");
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
