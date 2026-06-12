import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runStage1Maintenance, type MaintenanceEvent } from "../src/orchestrator.js";
import type { CommandRunResult } from "../src/types.js";

describe("runStage1Maintenance", () => {
  it("runs session-brief-refresh through the write transaction and leaves other writing jobs skipped", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, fleetYaml(vault, repo), "utf8");
    const events: MaintenanceEvent[] = [];

    const result = await runStage1Maintenance({
      fleetPath,
      hostId: "sg02",
      lockDir: join(root, "lock"),
      now: new Date("2026-06-13T00:00:00Z"),
      emit: (event) => events.push(event),
      runCommand: async (command, args, options) => {
        if (command === "npm" && args.join(" ") === "view skillwiki version") return commandResult("0.8.10\n");
        if (command === "skillwiki" && args.join(" ") === "--version") return commandResult("0.8.10\n");
        if (command === "skillwiki" && args[0] === "session-brief") {
          writeSessionBriefOutputs(vault);
          return commandResult(JSON.stringify({ ok: true }) + "\n");
        }
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result, null, 2));
    expect(result.data.checks.map((check) => [check.job, check.status])).toEqual([
      ["self-update-check", "pass"],
      ["vault-sync-preflight", "pass"],
      ["session-brief-refresh", "pass"],
    ]);
    expect(events.find((event) => event.job === "session-brief-refresh" && event.event === "job")?.status).toBe("pass");
    expect(events.find((event) => event.job === "agent-memory-trends-daily" && event.event === "skip")?.reason).toContain("deferred");
    expect(events.find((event) => event.job === "health-summary" && event.event === "skip")?.reason).toContain("deferred");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("chore(maintenance): refresh session brief");
  });
});

function fleetYaml(vault: string, repo: string): string {
  return `schema_version: 1
vault_remote: git@github.com:karlorz/wiki.git
s3_remote: seaweed-wiki:cloud/wiki
hosts:
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
  sg02:
    class: dev-linux
    role: leaf
    writes_to: [github]
    protected: false
    identity:
      hostnames: [sg02]
    maintenance:
      skillwiki_satellite:
        enabled: true
        user: agent-memory
        vault_path: ${vault}
        repo_path: ${repo}
        ssh_alias: sg02-agent-memory
        scheduler: systemd
        timezone: Asia/Hong_Kong
        jobs:
          - self-update-check
          - vault-sync-preflight
          - agent-memory-trends-daily
          - session-brief-refresh
          - health-summary
        cadence:
          self_update_check: every-4-hours
          daily_window: "00:10 Asia/Hong_Kong"
`;
}

function createSyncedRepo(origin: string, repo: string): string {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  git(repo, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(repo, "config", "user.name", "SkillWiki Maintenance Test");
  writeFileSync(join(repo, "package.json"), "{\"version\":\"0.8.10\"}\n", "utf8");
  mkdirSync(join(repo, "packages", "agent-memory-trends"), { recursive: true });
  writeFileSync(join(repo, "packages", "agent-memory-trends", "package.json"), "{\"version\":\"0.8.10\"}\n", "utf8");
  git(repo, "add", "package.json", "packages/agent-memory-trends/package.json");
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
}

function runGit(args: string[], cwd: string): CommandRunResult {
  try {
    return commandResult(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const typed = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return commandResult(String(typed.stdout ?? ""), typed.status ?? 1, String(typed.stderr ?? ""));
  }
}

function runNode(args: string[], cwd: string): CommandRunResult {
  try {
    return commandResult(execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const typed = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return commandResult(String(typed.stdout ?? ""), typed.status ?? 1, String(typed.stderr ?? ""));
  }
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commandResult(stdout = "", exitCode = 0, stderr = ""): CommandRunResult {
  return { exitCode, stdout, stderr };
}
