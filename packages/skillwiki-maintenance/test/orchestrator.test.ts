import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runStage1Maintenance, type MaintenanceEvent } from "../src/orchestrator.js";
import type { CommandRunResult } from "../src/types.js";

describe("runStage1Maintenance", () => {
  it("daily mode runs vault preflight and the trends writer without repo self-update or later writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-daily-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, fleetYaml(vault, repo), "utf8");
    const events: MaintenanceEvent[] = [];

    const result = await runStage1Maintenance({
      fleetPath,
      hostId: "sg02",
      lockDir: join(root, "lock"),
      mode: "daily",
      now: new Date("2026-06-13T00:00:00Z"),
      emit: (event) => events.push(event),
      runCommand: async (command, args, options) => {
        if (command === "agent-memory-trends" && args[0] === "daily") {
          writeGeneratedTrendOutputs(vault);
          return commandResult(JSON.stringify({
            ok: true,
            data: {
              mutations: [
                ".skillwiki/agent-memory-trends/2026-06-13-run.json",
                ".skillwiki/agent-memory-trends/latest-run.json",
                "queries/2026-06-13-agent-memory-trends-digest.md",
              ],
            },
          }) + "\n");
        }
        if (command === "skillwiki" && args[0] === "health") {
          writeHealthReport(outputPath(args));
          return commandResult("");
        }
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result, null, 2));
    expect(result.data.checks.map((check) => [check.job, check.status])).toEqual([
      ["vault-sync-preflight", "pass"],
      ["agent-memory-trends-daily", "pass"],
      ["health-summary", "pass"],
    ]);
    expect(events.find((event) => event.event === "start")?.details).toMatchObject({ stage: 2, mode: "daily" });
    expect(events.find((event) => event.job === "self-update-check")).toBeUndefined();
    expect(events.find((event) => event.job === "session-brief-refresh")).toBeUndefined();
    expect(events.find((event) => event.job === "vault-push")?.status).toBe("pass");
    expect(events.findIndex((event) => event.job === "vault-push")).toBeLessThan(
      events.findIndex((event) => event.job === "health-summary" && event.event === "job")
    );
    git(vault, "fetch", "origin", "main");
    expect(git(vault, "rev-list", "--left-right", "--count", "HEAD...origin/main")).toBe("0\t0");
  });

  it("emits the resolved satellite session policy on start", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-session-kind-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, fleetYaml(vault, repo), "utf8");
    const events: MaintenanceEvent[] = [];

    const result = await runStage1Maintenance({
      fleetPath,
      hostId: "sg02",
      lockDir: join(root, "lock"),
      mode: "daily",
      now: new Date("2026-06-13T00:00:00Z"),
      emit: (event) => events.push(event),
      runCommand: async (command, args, options) => {
        if (command === "agent-memory-trends" && args[0] === "daily") return commandResult("");
        if (command === "skillwiki" && args[0] === "health") {
          writeHealthReport(outputPath(args));
          return commandResult("");
        }
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    const start = events.find((event) => event.event === "start");
    expect(start?.details).toMatchObject({
      stage: 2,
      mode: "daily",
      sessionKind: {
        kind: "satellite",
        mayPrompt: false,
        defaultPolicy: "profile-allowed-or-fail",
        defaultSourceRequired: true,
      },
    });
  });

  it("rebases and retries when the vault remote advances after the daily commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-race-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, fleetYaml(vault, repo), "utf8");
    const events: MaintenanceEvent[] = [];
    let remoteAdvanced = false;

    const result = await runStage1Maintenance({
      fleetPath,
      hostId: "sg02",
      lockDir: join(root, "lock"),
      mode: "daily",
      now: new Date("2026-06-13T00:00:00Z"),
      emit: (event) => events.push(event),
      runCommand: async (command, args, options) => {
        if (command === "agent-memory-trends" && args[0] === "daily") {
          writeGeneratedTrendOutputs(vault);
          pushIndependentVaultChange(root, vault);
          remoteAdvanced = true;
          return commandResult(JSON.stringify({
            ok: true,
            data: {
              mutations: [
                ".skillwiki/agent-memory-trends/2026-06-13-run.json",
                ".skillwiki/agent-memory-trends/latest-run.json",
                "queries/2026-06-13-agent-memory-trends-digest.md",
              ],
            },
          }) + "\n");
        }
        if (command === "skillwiki" && args[0] === "health") {
          writeHealthReport(outputPath(args));
          return commandResult("");
        }
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result, null, 2));
    expect(remoteAdvanced).toBe(true);
    expect(events.find((event) => event.job === "vault-push")?.status).toBe("pass");
    git(vault, "fetch", "origin", "main");
    expect(git(vault, "rev-list", "--left-right", "--count", "HEAD...origin/main")).toBe("0\t0");
    expect(git(vault, "log", "--pretty=%s", "-2")).toBe([
      "research(agent-memory): daily digest",
      "auto: wiki sync during maintenance run",
    ].join("\n"));
  });

  it("aborts the retry rebase when the vault remote advances with a conflicting file", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-race-conflict-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, fleetYaml(vault, repo), "utf8");
    const events: MaintenanceEvent[] = [];

    const result = await runStage1Maintenance({
      fleetPath,
      hostId: "sg02",
      lockDir: join(root, "lock"),
      mode: "daily",
      now: new Date("2026-06-13T00:00:00Z"),
      emit: (event) => events.push(event),
      runCommand: async (command, args, options) => {
        if (command === "agent-memory-trends" && args[0] === "daily") {
          writeGeneratedTrendOutputs(vault);
          pushIndependentVaultConflict(root, vault);
          return commandResult(JSON.stringify({
            ok: true,
            data: {
              mutations: [
                ".skillwiki/agent-memory-trends/2026-06-13-run.json",
                ".skillwiki/agent-memory-trends/latest-run.json",
                "queries/2026-06-13-agent-memory-trends-digest.md",
              ],
            },
          }) + "\n");
        }
        if (command === "skillwiki" && args[0] === "health") {
          writeHealthReport(outputPath(args));
          return commandResult("");
        }
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected maintenance to fail");
    expect(result.detail).toMatchObject({ detail: expect.stringContaining("rebase before retry failed") });
    expect(events.find((event) => event.job === "vault-push")?.status).toBe("fail");
    expect(git(vault, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(vault, "rev-list", "--left-right", "--count", "HEAD...origin/main")).toBe("1\t1");
  });

  it("runs agent-memory-trends-daily through the write transaction and defers later writers after a commit", async () => {
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
        if (command === "agent-memory-trends" && args[0] === "daily") {
          writeGeneratedTrendOutputs(vault);
          return commandResult(JSON.stringify({
            ok: true,
            data: {
              mutations: [
                ".skillwiki/agent-memory-trends/2026-06-13-run.json",
                ".skillwiki/agent-memory-trends/latest-run.json",
                "queries/2026-06-13-agent-memory-trends-digest.md",
              ],
              humanHint: "daily: ok (generate-only); selected 1 candidate(s)",
            },
          }) + "\n");
        }
        if (command === "skillwiki" && args[0] === "session-brief") {
          writeSessionBriefOutputs(vault);
          return commandResult(JSON.stringify({ ok: true }) + "\n");
        }
        if (command === "skillwiki" && args[0] === "health") {
          writeHealthReport(outputPath(args));
          return commandResult("");
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
      ["agent-memory-trends-daily", "pass"],
      ["health-summary", "pass"],
    ]);
    expect(events.find((event) => event.job === "agent-memory-trends-daily" && event.event === "job")?.status).toBe("pass");
    expect(events.find((event) => event.job === "session-brief-refresh" && event.event === "skip")?.reason).toContain("prior writing job already committed");
    expect(events.find((event) => event.job === "health-summary" && event.event === "job")?.status).toBe("pass");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("research(agent-memory): daily digest");
  });

  it("self-update-apply mode runs preflight and apply without writer jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-apply-"));
    const repo = createSyncedRepo(join(root, "repo-origin.git"), join(root, "repo"));
    const vault = createSyncedVault(join(root, "vault-origin.git"), join(root, "vault"));
    const fleetPath = join(root, "fleet.yaml");
    writeFileSync(fleetPath, fleetYaml(vault, repo), "utf8");
    const events: MaintenanceEvent[] = [];

    const result = await runStage1Maintenance({
      fleetPath,
      hostId: "sg02",
      lockDir: join(root, "lock"),
      mode: "self-update-apply",
      now: new Date("2026-06-13T00:00:00Z"),
      emit: (event) => events.push(event),
      runCommand: async (command, args, options) => {
        if (command === "npm" && args.join(" ") === "view skillwiki version") return commandResult("0.8.10\n");
        if (command === "skillwiki" && args.join(" ") === "--version") return commandResult("0.8.10\n");
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    if (!result.ok) throw new Error(JSON.stringify(result, null, 2));
    expect(result.data.checks.map((check) => [check.job, check.status])).toEqual([
      ["vault-sync-preflight", "pass"],
      ["self-update-apply", "pass"],
    ]);
    expect(events.find((event) => event.job === "agent-memory-trends-daily")).toBeUndefined();
    expect(events.find((event) => event.job === "session-brief-refresh")).toBeUndefined();
  });

  it("does not run later writing jobs after agent-memory-trends-daily fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillwiki-maintenance-orch-fail-"));
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
        if (command === "agent-memory-trends" && args[0] === "daily") return commandResult("");
        if (command === "skillwiki" && args[0] === "session-brief") {
          writeSessionBriefOutputs(vault);
          return commandResult(JSON.stringify({ ok: true }) + "\n");
        }
        if (command === "skillwiki" && args[0] === "health") {
          writeHealthReport(outputPath(args), {
            overall_status: "warn",
            advisory_status: "warn",
            risk_flags: [{ id: "maintenance_backlog", status: "warn", blocking: false }],
          });
          return commandResult("");
        }
        if (command === "node") return runNode(args, options.cwd);
        if (command === "git") return runGit(args, options.cwd);
        return commandResult("", 127, `unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(events.find((event) => event.job === "agent-memory-trends-daily" && event.event === "job")?.status).toBe("fail");
    const sessionBriefSkip = events.find((event) => event.job === "session-brief-refresh" && event.event === "skip");
    const healthSummaryEvent = events.find((event) => event.job === "health-summary" && event.event === "job");
    expect(sessionBriefSkip).toBeTruthy();
    expect(sessionBriefSkip?.reason).toContain("prior writing job failed");
    expect(healthSummaryEvent?.status).toBe("warn");
    expect(git(vault, "log", "-1", "--pretty=%s")).toBe("initial");
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
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
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
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
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

function writeGeneratedTrendOutputs(vault: string): void {
  mkdirSync(join(vault, ".skillwiki", "agent-memory-trends"), { recursive: true });
  mkdirSync(join(vault, "queries"), { recursive: true });
  writeFileSync(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-13-run.json"), "{}\n", "utf8");
  writeFileSync(join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json"), "{}\n", "utf8");
  writeFileSync(join(vault, "queries", "2026-06-13-agent-memory-trends-digest.md"), "# Digest\n", "utf8");
}

function writeHealthReport(
  path: string,
  overrides: Partial<{
    overall_status: "pass" | "info" | "warn" | "error" | "unknown";
    blocking_status: "pass" | "info" | "warn" | "error" | "unknown";
    advisory_status: "pass" | "info" | "warn" | "error" | "unknown";
    risk_flags: Array<{ id: string; status: "pass" | "info" | "warn" | "error" | "unknown"; blocking: boolean }>;
    warnings: Array<{ id: string; message: string }>;
    humanHint: string;
  }> = {}
): void {
  writeFileSync(path, JSON.stringify({
    ok: true,
    data: {
      overall_status: "pass",
      blocking_status: "pass",
      advisory_status: "pass",
      risk_flags: [],
      warnings: [],
      humanHint: "vault health looks good",
      self_check: { status: "pass", errors: [] },
      ...overrides,
    },
  }) + "\n", "utf8");
}

function outputPath(args: string[]): string {
  const index = args.indexOf("--out");
  if (index === -1 || !args[index + 1]) throw new Error(`missing --out path in args: ${args.join(" ")}`);
  return args[index + 1]!;
}

function pushIndependentVaultChange(root: string, vault: string): void {
  const clone = join(root, "independent-vault-writer");
  const origin = git(vault, "remote", "get-url", "origin");
  execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });
  git(clone, "branch", "-M", "main");
  git(clone, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(clone, "config", "user.name", "SkillWiki Maintenance Test");
  writeFileSync(join(clone, "log.md"), "# Log\n\n## concurrent sync\n", "utf8");
  git(clone, "add", "log.md");
  git(clone, "commit", "-m", "auto: wiki sync during maintenance run");
  git(clone, "push", "origin", "main");
}

function pushIndependentVaultConflict(root: string, vault: string): void {
  const clone = join(root, "independent-vault-conflict");
  const origin = git(vault, "remote", "get-url", "origin");
  execFileSync("git", ["clone", origin, clone], { stdio: "ignore" });
  git(clone, "branch", "-M", "main");
  git(clone, "config", "user.email", "skillwiki-maintenance@example.invalid");
  git(clone, "config", "user.name", "SkillWiki Maintenance Test");
  mkdirSync(join(clone, "queries"), { recursive: true });
  writeFileSync(join(clone, "queries", "2026-06-13-agent-memory-trends-digest.md"), "# Concurrent Digest\n", "utf8");
  git(clone, "add", "queries/2026-06-13-agent-memory-trends-digest.md");
  git(clone, "commit", "-m", "auto: conflicting wiki sync during maintenance run");
  git(clone, "push", "origin", "main");
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
