import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentMemoryTrendsCli } from "../src/cli.js";
import type { SelectedGithubCandidate } from "../src/github.js";

const CONFIG = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 35
    actionability: 25
    authority_activity: 20
    freshness: 10
    novelty: 10
github:
  api_call_budget: 100
  max_queries: 10
  max_raw_candidates: 50
  max_selected_candidates: 10
  queries:
    - { id: claude-agent-memory, label: Claude agent memory, query: "claude agent memory in:name,description,readme" }
    - { id: codex-agent-memory, label: Codex agent memory, query: "codex agent memory in:name,description,readme" }
    - { id: cross-agent-memory, label: cross-agent memory, query: "cross agent memory in:name,description,readme" }
    - { id: session-continuity-agent, label: session continuity agent, query: "session continuity agent in:name,description,readme" }
    - { id: mcp-memory, label: MCP memory, query: "MCP memory agent in:name,description,readme" }
    - { id: obsidian-agent-memory, label: Obsidian agent memory, query: "obsidian agent memory in:name,description,readme" }
    - { id: markdown-knowledge-base-agent, label: Markdown knowledge base agent, query: "markdown knowledge base agent in:name,description,readme" }
    - { id: sqlite-agent-memory, label: SQLite agent memory, query: "sqlite agent memory in:name,description,readme" }
    - { id: second-brain-agent-memory, label: second brain agent memory, query: "second brain agent memory in:name,description,readme" }
    - { id: local-first-memory-sync, label: local-first memory sync, query: "local first memory sync in:name,description,readme" }
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;

function selectedCandidate(): SelectedGithubCandidate {
  return {
    name: "local-agent-memory",
    fullName: "acme/local-agent-memory",
    canonicalUrl: "https://github.com/acme/local-agent-memory",
    description: "Markdown agent memory with local-first sync.",
    topics: ["agent-memory", "markdown"],
    readmeText: "Useful for Codex and Claude session continuity.",
    stargazersCount: 120,
    forksCount: 12,
    pushedAt: "2026-06-10T00:00:00Z",
    archived: false,
    queryIds: ["cross-agent-memory"],
    score: {
      score: 82,
      components: {
        relevance: 30,
        actionability: 20,
        authorityActivity: 16,
        freshness: 8,
        novelty: 8,
      },
      reasons: ["strong agent-memory match"],
    },
  };
}

describe("agent-memory-trends CLI", () => {
  function successfulDoctorContext(
    options: {
      headSha?: string;
      originSha?: string;
      headIsAncestorOfOrigin?: boolean;
      rootVersion?: string;
      runnerVersion?: string;
      originRootVersion?: string;
      originRunnerVersion?: string;
      sessionBriefJson?: string | null;
      sessionBriefMeta?: string | null;
      latestRunJson?: string | null;
      now?: Date;
    } = {}
  ) {
    const toolCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const ghCalls: string[][] = [];
    const headSha = options.headSha ?? "d7ded42d7ded42d7ded42d7ded42d7ded42d";
    const originSha = options.originSha ?? headSha;
    const rootVersion = options.rootVersion ?? "0.8.10-beta.1";
    const runnerVersion = options.runnerVersion ?? rootVersion;
    const originRootVersion = options.originRootVersion ?? rootVersion;
    const originRunnerVersion = options.originRunnerVersion ?? runnerVersion;
    const files = new Map<string, string>([
      ["/config.yaml", CONFIG],
      [
        "/vault/.skillwiki/session-brief.json",
        options.sessionBriefJson ?? JSON.stringify({ generated_at: "2026-06-10T23:50:00Z" }),
      ],
      [
        "/vault/meta/latest-session-brief.md",
        options.sessionBriefMeta ?? "---\ngenerated_at: 2026-06-10T23:50:00Z\n---\n# Latest Session Brief\n",
      ],
      [
        "/vault/.skillwiki/agent-memory-trends/latest-run.json",
        options.latestRunJson ?? JSON.stringify({ finishedAt: "2026-06-10T22:00:00Z" }),
      ],
    ]);
    if (options.sessionBriefJson === null) files.delete("/vault/.skillwiki/session-brief.json");
    if (options.sessionBriefMeta === null) files.delete("/vault/meta/latest-session-brief.md");
    if (options.latestRunJson === null) files.delete("/vault/.skillwiki/agent-memory-trends/latest-run.json");

    return {
      toolCalls,
      ghCalls,
      context: {
        cwd: "/repo",
        env: {
          AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://kuma.example/push",
        },
        now: options.now ?? new Date("2026-06-11T00:10:00Z"),
        readFile: (path: string) => {
          const body = files.get(path);
          if (body === undefined) throw new Error(`unexpected readFile path: ${path}`);
          return body;
        },
        pathExists: (path: string) => path === "/vault" || path === "/repo" || files.has(path),
        runGh: async (args: string[]) => {
          ghCalls.push(args);
          if (args[0] === "auth" && args[1] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "api" && args[1] === "rate_limit") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                resources: {
                  core: { remaining: 4900, limit: 5000, reset: 1781126400 },
                  search: { remaining: 29, limit: 30, reset: 1781126400 },
                },
              }),
              stderr: "",
            };
          }
          throw new Error(`unexpected gh call: ${args.join(" ")}`);
        },
        runCommand: async (command: string, args: string[], commandOptions: { cwd: string }) => {
          toolCalls.push({ command, args, cwd: commandOptions.cwd });
          if (command === "git" && args.join(" ") === "-C /repo fetch origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /repo rev-parse HEAD") {
            return { exitCode: 0, stdout: `${headSha}\n`, stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /repo rev-parse origin/main") {
            return { exitCode: 0, stdout: `${originSha}\n`, stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /repo merge-base --is-ancestor HEAD origin/main") {
            return { exitCode: options.headIsAncestorOfOrigin ?? true ? 0 : 1, stdout: "", stderr: "" };
          }
          if (command === process.execPath && args.join(" ") === "-p require('./package.json').version") {
            return { exitCode: 0, stdout: `${rootVersion}\n`, stderr: "" };
          }
          if (command === process.execPath && args.join(" ") === "-p require('./packages/agent-memory-trends/package.json').version") {
            return { exitCode: 0, stdout: `${runnerVersion}\n`, stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /repo show origin/main:package.json") {
            return { exitCode: 0, stdout: JSON.stringify({ version: originRootVersion }), stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /repo show origin/main:packages/agent-memory-trends/package.json") {
            return { exitCode: 0, stdout: JSON.stringify({ version: originRunnerVersion }), stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /vault status --short") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /vault push --dry-run origin main") {
            return { exitCode: 0, stdout: "Everything up-to-date", stderr: "" };
          }
          if (command === "codex" && args.join(" ") === "doctor --json") {
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
          if (command === "skillwiki" && args.join(" ") === "doctor") {
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    };
  }

  function sessionBriefJson(generatedAt: string): string {
    return JSON.stringify({ generated_at: generatedAt });
  }

  function sessionBriefMeta(generatedAt: string): string {
    return `---\ngenerated_at: ${generatedAt}\n---\n# Latest Session Brief\n`;
  }

  function latestRunJson(finishedAt: string): string {
    return JSON.stringify({ finishedAt });
  }

  function doctorChecks(result: Awaited<ReturnType<typeof runAgentMemoryTrendsCli>>) {
    if (result.result.ok) return result.result.data.checks ?? [];
    const detail = result.result.detail as { checks?: Array<{ name: string; status: string; message: string }> } | undefined;
    return detail?.checks ?? [];
  }

  function doctorCheck(result: Awaited<ReturnType<typeof runAgentMemoryTrendsCli>>, name: string) {
    const check = doctorChecks(result).find((candidate) => candidate.name === name);
    expect(check).toBeTruthy();
    return check;
  }

  it("returns read-only help for global and pseudo-command help requests", async () => {
    for (const argv of [["--help"], ["help"]] as string[][]) {
      const result = await runAgentMemoryTrendsCli(argv, {
        cwd: "/repo",
        env: {},
        now: new Date("2026-06-11T00:10:00Z"),
        readFile: () => {
          throw new Error("help should not read config");
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.result.ok).toBe(true);
      if (!result.result.ok) throw new Error("expected help success");
      expect(result.result.data.command).toBe("help");
      expect(result.result.data.mutations).toEqual([]);
      expect(result.result.data.humanHint).toContain("Usage: agent-memory-trends");
    }
  });

  it.each([
    ["--help"],
    ["-h"],
  ])("returns read-only help for daily %s without running daily hooks", async (helpFlag) => {
    const calls: string[] = [];
    const result = await runAgentMemoryTrendsCli(["daily", helpFlag, "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      cwd: "/repo",
      env: {
        AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://kuma.example/push",
      },
      now: new Date("2026-06-11T00:10:00Z"),
      readFile: () => {
        calls.push("read-config");
        return CONFIG;
      },
      collectGithubCandidates: async () => {
        calls.push("collect");
        return { ok: true, data: {
          rateLimit: { resources: { core: { remaining: 5000, limit: 5000, reset: 1 }, search: { remaining: 30, limit: 30, reset: 1 } } },
          apiCallsUsed: 12,
          rawCandidateCount: 1,
          selectedCandidates: [selectedCandidate()],
          runSummary: { rawCandidateCount: 1, selectedCandidateCount: 1, apiCallsUsed: 12 },
        } };
      },
      collectDuplicateSignals: () => {
        calls.push("dedupe");
        return { ok: true, data: { existingTasks: [], activeWork: [], recentDigests: [] } };
      },
      writeAgentInput: () => {
        calls.push("write-input");
        return { ok: true, data: { path: "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json" } };
      },
      runSynthesis: async (input) => {
        calls.push("synthesis");
        return {
          ok: true,
          data: {
            manifestPath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json",
            outputLastMessagePath: input.outputLastMessagePath,
            stdout: "",
            stderr: "",
            output: {
              proposals: [
                {
                  title: "Evaluate local agent memory bridge",
                  captureKind: "idea",
                  problem: "A source-backed bridge may be useful but needs inspection.",
                  requirementsOrQuestions: ["Inspect the README-backed source before queuing implementation."],
                  acceptance: ["A reviewed decision exists before a planned work item is created."],
                  evidence: [
                    {
                      sourceUrl: "https://github.com/acme/local-agent-memory#readme",
                      excerpt: "Local-first agent memory for Claude and Codex sessions.",
                      supportsClaim: "The README describes local-first cross-agent memory.",
                      confidence: "medium",
                    },
                  ],
                  affectedSurfaces: ["agent-memory-trends"],
                  sourceUrls: ["https://github.com/acme/local-agent-memory#readme"],
                },
              ],
            },
          },
        };
      },
      renderProposalCaptures: (input) => {
        calls.push("render");
        expect(input.manifestPath).toBe(".skillwiki/agent-memory-trends/2026-06-11-run.json");
        expect(input.output.proposals).toHaveLength(1);
        return {
          ok: true,
          data: {
            renderedPaths: ["raw/transcripts/2026-06-11-idea-evaluate-local-agent-memory-bridge.md"],
            validationErrors: [],
            duplicateSuppressions: [],
          },
        };
      },
      publishGeneratedChanges: async () => {
        calls.push("publish");
        return { ok: true, data: { baseCommit: "abc123", changedFiles: [], commitMessage: "noop" } };
      },
      maybeSendHeartbeat: async () => {
        calls.push("heartbeat");
        return { ok: true, data: { status: "sent", url: "https://kuma.example/push" } };
      },
      writeRunState: () => {
        calls.push("write-state");
        return {
          ok: true,
          data: {
            runStatePath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json",
            latestRunPath: "/vault/.skillwiki/agent-memory-trends/latest-run.json",
          },
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected help success");
    expect(result.result.data.command).toBe("help");
    expect(result.result.data.mutations).toEqual([]);
    expect(result.result.data.humanHint).toContain("Usage: agent-memory-trends");
    expect(calls).toEqual([]);
  });

  it("keeps unknown commands as usage errors when help is not requested", async () => {
    const result = await runAgentMemoryTrendsCli(["bogus"], {
      cwd: "/repo",
      env: {},
      now: new Date("2026-06-11T00:10:00Z"),
    });

    expect(result.exitCode).toBe(46);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected usage error");
    expect(result.result.error).toBe("USAGE");
    expect(result.result.detail).toEqual({
      message: "Usage: agent-memory-trends <doctor|collect|daily|publish> [--dry-run] [--generate-only] [--help]",
    });
  });

  it.each(["publish"] as const)("supports %s command", async (command) => {
    const result = await runAgentMemoryTrendsCli([command, "--dry-run"], {
      cwd: "/tmp",
      env: {},
      now: new Date("2026-06-11T00:10:00Z")
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.command).toBe(command);
    expect(result.result.data.dryRun).toBe(true);
  });

  it("preflights rollout dependencies in doctor and keeps output structured", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.status).toBe("ok");
    expect(result.result.data.mutations).toEqual([]);
    expect(result.result.data.checks?.map((check) => [check.name, check.status])).toEqual([
      ["config", "pass"],
      ["vault_path", "pass"],
      ["repo_path", "pass"],
      ["runner_source", "pass"],
      ["runner_version", "pass"],
      ["session_brief_freshness", "pass"],
      ["gh_auth", "pass"],
      ["gh_rate_limit", "pass"],
      ["codex_doctor", "pass"],
      ["skillwiki_doctor", "pass"],
      ["vault_git_clean", "pass"],
      ["vault_git_push", "pass"],
      ["heartbeat_env", "pass"],
    ]);
    expect(fixture.ghCalls).toEqual([
      ["auth", "status"],
      ["api", "rate_limit"],
    ]);
    expect(fixture.toolCalls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "git -C /repo fetch origin main",
      "git -C /repo rev-parse HEAD",
      "git -C /repo rev-parse origin/main",
      `${process.execPath} -p require('./package.json').version`,
      `${process.execPath} -p require('./packages/agent-memory-trends/package.json').version`,
      "git -C /repo show origin/main:package.json",
      "git -C /repo show origin/main:packages/agent-memory-trends/package.json",
      "codex doctor --json",
      "skillwiki doctor",
      "git -C /vault status --short",
      "git -C /vault push --dry-run origin main",
    ]);
    expect(result.result.data.humanHint).toContain("doctor: ok");
  });

  it("fails doctor when the runner checkout is behind origin/main", async () => {
    const fixture = successfulDoctorContext({
      headSha: "237a312237a312237a312237a312237a312",
      originSha: "d7ded42d7ded42d7ded42d7ded42d7ded42d",
    });
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    const check = doctorCheck(result, "runner_source");
    expect(check).toMatchObject({
      status: "fail",
      message: "runner checkout is behind origin/main: HEAD 237a312, origin/main d7ded42",
    });
    if (result.result.ok) throw new Error("expected doctor failure");
    expect(result.result.detail).toMatchObject({
      failedChecks: ["runner_source"],
    });
  });

  it("fails doctor when local runner package versions are older than origin/main", async () => {
    const fixture = successfulDoctorContext({
      rootVersion: "0.8.9",
      runnerVersion: "0.8.9",
      originRootVersion: "0.8.10-beta.1",
      originRunnerVersion: "0.8.10-beta.1",
    });
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    const check = doctorCheck(result, "runner_version");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("root 0.8.9 < 0.8.10-beta.1");
    expect(check?.message).toContain("agent-memory-trends 0.8.9 < 0.8.10-beta.1");
    if (result.result.ok) throw new Error("expected doctor failure");
    expect(result.result.detail).toMatchObject({
      failedChecks: ["runner_version"],
    });
  });

  it("warns doctor when session brief files are 24 to 72 hours old", async () => {
    const fixture = successfulDoctorContext({
      sessionBriefJson: sessionBriefJson("2026-06-09T23:00:00Z"),
      sessionBriefMeta: sessionBriefMeta("2026-06-09T23:00:00Z"),
      latestRunJson: latestRunJson("2026-06-09T22:00:00Z"),
    });
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    const check = doctorCheck(result, "session_brief_freshness");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain(".skillwiki/session-brief.json 25h old");
    expect(check?.message).toContain("meta/latest-session-brief.md 25h old");
  });

  it("fails doctor when session brief files are older than 72 hours", async () => {
    const fixture = successfulDoctorContext({
      sessionBriefJson: sessionBriefJson("2026-06-07T23:00:00Z"),
      sessionBriefMeta: sessionBriefMeta("2026-06-07T23:00:00Z"),
      latestRunJson: latestRunJson("2026-06-07T22:00:00Z"),
    });
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    const check = doctorCheck(result, "session_brief_freshness");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("session brief file(s) stale");
    if (result.result.ok) throw new Error("expected doctor failure");
    expect(result.result.detail).toMatchObject({
      failedChecks: ["session_brief_freshness"],
    });
  });

  it("fails doctor when a session brief file is missing or unparsable", async () => {
    const fixture = successfulDoctorContext({
      sessionBriefJson: "{not-json",
      sessionBriefMeta: null,
    });
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    const check = doctorCheck(result, "session_brief_freshness");
    expect(check).toMatchObject({
      status: "fail",
      message: "session brief file(s) missing or generated_at is unparsable: .skillwiki/session-brief.json, meta/latest-session-brief.md",
    });
  });

  it("fails doctor when a session brief file is older than the latest digest run", async () => {
    const fixture = successfulDoctorContext({
      sessionBriefJson: sessionBriefJson("2026-06-11T00:06:00Z"),
      sessionBriefMeta: sessionBriefMeta("2026-06-11T00:00:00Z"),
      latestRunJson: latestRunJson("2026-06-11T00:05:00Z"),
    });
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], fixture.context);

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    const check = doctorCheck(result, "session_brief_freshness");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("older than latest agent-memory run 2026-06-11T00:05:00Z");
    expect(check?.message).toContain("meta/latest-session-brief.md generated_at 2026-06-11T00:00:00Z");
  });

  it("fails doctor when the vault Git push dry-run fails", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      ...fixture.context,
      runCommand: async (command, args, options) => {
        fixture.toolCalls.push({ command, args, cwd: options.cwd });
        if (command === "git" && args.join(" ") === "-C /vault push --dry-run origin main") {
          return { exitCode: 128, stdout: "", stderr: "Permission denied (publickey)." };
        }
        return fixture.context.runCommand!(command, args, options);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected doctor failure");
    expect(result.result.error).toBe("DOCTOR_FAILED");
    expect(result.result.detail).toMatchObject({
      failedChecks: ["vault_git_push"],
    });
  });

  it("fails doctor when a required rollout preflight check fails", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      ...fixture.context,
      runGh: async (args) => {
        fixture.ghCalls.push(args);
        if (args[0] === "auth" && args[1] === "status") {
          return { exitCode: 1, stdout: "", stderr: "not logged in" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected doctor failure");
    expect(result.result.error).toBe("DOCTOR_FAILED");
    expect(result.result.detail).toMatchObject({
      failedChecks: ["gh_auth"],
    });
  });

  it("does not fail doctor when skillwiki doctor reports warning-only structured output", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      ...fixture.context,
      runCommand: async (command, args, options) => {
        fixture.toolCalls.push({ command, args, cwd: options.cwd });
        if (command === "skillwiki" && args.join(" ") === "doctor") {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              ok: true,
              data: {
                summary: { pass: 30, info: 5, warn: 2, error: 0 },
              },
            }),
            stderr: "",
          };
        }
        return fixture.context.runCommand!(command, args, options);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected doctor success");
    expect(result.result.data.checks?.find((check) => check.name === "skillwiki_doctor")).toMatchObject({
      status: "warn",
      message: "skillwiki doctor reported 2 warning(s) and 0 error(s)",
    });
  });

  it("does not fail doctor when codex doctor only reports a non-interactive terminal failure", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      ...fixture.context,
      runCommand: async (command, args, options) => {
        fixture.toolCalls.push({ command, args, cwd: options.cwd });
        if (command === "codex" && args.join(" ") === "doctor --json") {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              overallStatus: "fail",
              checks: {
                "auth.credentials": { status: "ok", summary: "auth is configured" },
                "config.load": { status: "ok", summary: "config loaded" },
                "runtime.provenance": { status: "ok", summary: "running npm on linux-x64" },
                "runtime.search": { status: "ok", summary: "search is OK" },
                "git.environment": { status: "ok", summary: "git version 2.52.0" },
                "network.provider_reachability": { status: "ok", summary: "active provider endpoints are reachable" },
                "terminal.env": {
                  status: "fail",
                  summary: "TERM=dumb - colors and cursor control are disabled",
                },
              },
            }),
            stderr: "",
          };
        }
        return fixture.context.runCommand!(command, args, options);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected doctor success");
    expect(result.result.data.checks?.find((check) => check.name === "codex_doctor")).toMatchObject({
      status: "warn",
      message: "codex doctor reported terminal-only failure: TERM=dumb - colors and cursor control are disabled",
    });
  });

  it("fails doctor when codex doctor reports a non-terminal failure", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      ...fixture.context,
      runCommand: async (command, args, options) => {
        fixture.toolCalls.push({ command, args, cwd: options.cwd });
        if (command === "codex" && args.join(" ") === "doctor --json") {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              overallStatus: "fail",
              checks: {
                "auth.credentials": {
                  status: "fail",
                  summary: "auth is not configured",
                },
                "terminal.env": {
                  status: "fail",
                  summary: "TERM=dumb - colors and cursor control are disabled",
                },
              },
            }),
            stderr: "",
          };
        }
        return fixture.context.runCommand!(command, args, options);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("expected doctor failure");
    expect(result.result.detail).toMatchObject({
      failedChecks: ["codex_doctor"],
    });
  });

  it("falls back to the repo-local skillwiki build when the workspace skillwiki bin has no output", async () => {
    const fixture = successfulDoctorContext();
    const result = await runAgentMemoryTrendsCli(["doctor", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      ...fixture.context,
      runCommand: async (command, args, options) => {
        fixture.toolCalls.push({ command, args, cwd: options.cwd });
        if (command === "skillwiki" && args.join(" ") === "doctor") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (command === "npm" && args.join(" ") === "run -w skillwiki --silent build") {
          return { exitCode: 0, stdout: "built", stderr: "" };
        }
        if (command === process.execPath && args.join(" ") === "/repo/packages/cli/dist/cli.js doctor") {
          return {
            exitCode: 1,
            stdout: JSON.stringify({
              ok: true,
              data: {
                summary: { pass: 30, info: 5, warn: 2, error: 0 },
              },
            }),
            stderr: "",
          };
        }
        return fixture.context.runCommand!(command, args, options);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected doctor success");
    expect(fixture.toolCalls.map((call) => `${call.command} ${call.args.join(" ")}`)).toContain(
      "npm run -w skillwiki --silent build"
    );
    expect(result.result.data.checks?.find((check) => check.name === "skillwiki_doctor")).toMatchObject({
      status: "warn",
      message: "skillwiki doctor reported 2 warning(s) and 0 error(s)",
    });
  });

  it("wires collect --dry-run through config, collector, and input preparation without publishing", async () => {
    const ghCalls: string[][] = [];
    const result = await runAgentMemoryTrendsCli(["collect", "--dry-run", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      cwd: "/repo",
      env: {},
      now: new Date("2026-06-11T00:10:00+08:00"),
      readFile: (path) => {
        expect(path).toBe("/config.yaml");
        return CONFIG;
      },
      collectGithubCandidates: async () => ({ ok: true, data: {
        rateLimit: { resources: { core: { remaining: 5000, limit: 5000, reset: 1 }, search: { remaining: 30, limit: 30, reset: 1 } } },
        apiCallsUsed: 12,
        rawCandidateCount: 1,
        selectedCandidates: [selectedCandidate()],
        runSummary: { rawCandidateCount: 1, selectedCandidateCount: 1, apiCallsUsed: 12 },
      } }),
      collectDuplicateSignals: () => ({ ok: true, data: { existingTasks: [], activeWork: [], recentDigests: [] } }),
      writeAgentInput: (input) => {
        expect(input.selectedCandidates).toHaveLength(1);
        return { ok: true, data: { path: "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json" } };
      },
      runGh: async (args) => {
        ghCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected collect success");
    expect(result.result.data.mutations).toEqual([
      "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json",
    ]);
    expect(result.result.data.humanHint).toContain("selected 1 candidate");
    expect(ghCalls).toEqual([]);
  });

  it("wires daily --dry-run through collect, synthesis, run-state, and skips publish plus heartbeat", async () => {
    const calls: string[] = [];
    const result = await runAgentMemoryTrendsCli(["daily", "--dry-run", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      cwd: "/repo",
      env: {
        AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://kuma.example/push",
      },
      now: new Date("2026-06-11T00:10:00+08:00"),
      readFile: () => CONFIG,
      collectGithubCandidates: async () => ({ ok: true, data: {
        rateLimit: { resources: { core: { remaining: 5000, limit: 5000, reset: 1 }, search: { remaining: 30, limit: 30, reset: 1 } } },
        apiCallsUsed: 12,
        rawCandidateCount: 1,
        selectedCandidates: [selectedCandidate()],
        runSummary: { rawCandidateCount: 1, selectedCandidateCount: 1, apiCallsUsed: 12 },
      } }),
      collectDuplicateSignals: () => ({ ok: true, data: { existingTasks: [], activeWork: [], recentDigests: [] } }),
      writeAgentInput: () => ({ ok: true, data: { path: "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json" } }),
      runSynthesis: async (input) => {
        calls.push(`synthesis:${input.input.runId}`);
        return {
          ok: true,
          data: {
            manifestPath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json",
            outputLastMessagePath: input.outputLastMessagePath,
            stdout: "",
            stderr: "",
            output: { proposals: [] },
          },
        };
      },
      publishGeneratedChanges: async () => {
        calls.push("publish");
        return { ok: true, data: { baseCommit: "abc123", changedFiles: [], commitMessage: "noop" } };
      },
      maybeSendHeartbeat: async () => {
        calls.push("heartbeat");
        return { ok: true, data: { status: "sent", url: "https://kuma.example/push" } };
      },
      writeRunState: (vault, state) => {
        expect(vault).toBe("/vault");
        expect(state.status).toBe("success");
        expect(state.heartbeat).toEqual({ status: "skipped", reason: "dry-run" });
        return {
          ok: true,
          data: {
            runStatePath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json",
            latestRunPath: "/vault/.skillwiki/agent-memory-trends/latest-run.json",
          },
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected daily success");
    expect(calls).toEqual(["synthesis:2026-06-11T00-10-00+08-00"]);
    expect(result.result.data.mutations).toContain("/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json");
    expect(result.result.data.humanHint).toContain("daily: ok (dry-run)");
  });

  it("wires live daily through publish without rewriting run-state after the publish commit", async () => {
    const calls: string[] = [];
    const evidencePath = "raw/articles/2026-06-11-agent-memory-trends-evidence-2026-06-11T00-10-00+08-00.md";
    const sessionBriefFiles = [
      "meta/latest-session-brief.md",
      ".skillwiki/session-brief.md",
      ".skillwiki/session-brief.json",
    ];
    const publishedFiles = [
      ".skillwiki/agent-memory-trends/2026-06-11-input.json",
      ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
      ...sessionBriefFiles,
      "queries/2026-06-11-agent-memory-trends-digest.md",
      evidencePath,
    ];
    const result = await runAgentMemoryTrendsCli(["daily", "--vault", "/vault", "--repo", "/repo", "--config", "/config.yaml"], {
      cwd: "/repo",
      env: {},
      now: new Date("2026-06-11T00:10:00+08:00"),
      readFile: () => CONFIG,
      collectGithubCandidates: async () => ({ ok: true, data: {
        rateLimit: { resources: { core: { remaining: 5000, limit: 5000, reset: 1 }, search: { remaining: 30, limit: 30, reset: 1 } } },
        apiCallsUsed: 12,
        rawCandidateCount: 1,
        selectedCandidates: [selectedCandidate()],
        runSummary: { rawCandidateCount: 1, selectedCandidateCount: 1, apiCallsUsed: 12 },
      } }),
      collectDuplicateSignals: () => ({ ok: true, data: { existingTasks: [], activeWork: [], recentDigests: [] } }),
      writeAgentInput: (input) => {
        expect(input.allowedOutputs.evidencePath).toBe(evidencePath);
        return { ok: true, data: { path: "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json" } };
      },
      runSynthesis: async (input) => {
        calls.push("synthesis");
        return {
          ok: true,
          data: {
            manifestPath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json",
            outputLastMessagePath: input.outputLastMessagePath,
            stdout: "",
            stderr: "",
            output: {
              proposals: [
                {
                  title: "Evaluate local agent memory bridge",
                  captureKind: "idea",
                  problem: "A source-backed bridge may be useful but needs inspection.",
                  requirementsOrQuestions: ["Inspect the README-backed source before queuing implementation."],
                  acceptance: ["A reviewed decision exists before a planned work item is created."],
                  evidence: [
                    {
                      sourceUrl: "https://github.com/acme/local-agent-memory#readme",
                      excerpt: "Local-first agent memory for Claude and Codex sessions.",
                      supportsClaim: "The README describes local-first cross-agent memory.",
                      confidence: "medium",
                    },
                  ],
                  affectedSurfaces: ["agent-memory-trends"],
                  sourceUrls: ["https://github.com/acme/local-agent-memory#readme"],
                },
              ],
            },
          },
        };
      },
      renderProposalCaptures: (input) => {
        calls.push("render");
        expect(input.manifestPath).toBe(".skillwiki/agent-memory-trends/2026-06-11-run.json");
        expect(input.output.proposals).toHaveLength(1);
        return {
          ok: true,
          data: {
            renderedPaths: ["raw/transcripts/2026-06-11-idea-evaluate-local-agent-memory-bridge.md"],
            validationErrors: [],
            duplicateSuppressions: [],
          },
        };
      },
      refreshSessionBrief: async (input) => {
        calls.push("refresh-brief");
        expect(input).toEqual({
          vault: "/vault",
          repo: "/repo",
          project: "llm-wiki",
        });
        return { ok: true, data: { filesWritten: sessionBriefFiles } };
      },
      listTrackedRawPaths: async (vault) => {
        expect(vault).toBe("/vault");
        return { ok: true, data: ["raw/articles/2026-06-10-agent-memory-trends-evidence.md"] };
      },
      publishGeneratedChanges: async (input) => {
        calls.push("publish");
        expect(input.existingRawPaths).toEqual(["raw/articles/2026-06-10-agent-memory-trends-evidence.md"]);
        return {
          ok: true,
          data: {
            baseCommit: "abc123",
            changedFiles: publishedFiles,
            commitMessage: "research(agent-memory): daily digest 2026-06-11",
          },
        };
      },
      maybeSendHeartbeat: async () => {
        calls.push("heartbeat");
        return { ok: true, data: { status: "skipped", reason: "heartbeat URL missing" } };
      },
      writeRunState: () => {
        calls.push("write-state");
        return {
          ok: true,
          data: {
            runStatePath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json",
            latestRunPath: "/vault/.skillwiki/agent-memory-trends/latest-run.json",
          },
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected daily success");
    expect(calls).toEqual(["synthesis", "render", "refresh-brief", "publish", "heartbeat"]);
    expect(result.result.data.mutations).toEqual([
      "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json",
      ...publishedFiles,
    ]);
  });

  it("wires daily --generate-only through generation without publish, heartbeat, or session brief refresh", async () => {
    const calls: string[] = [];
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-generate-only-"));
    mkdirSync(join(vault, ".skillwiki", "agent-memory-trends"), { recursive: true });
    mkdirSync(join(vault, "queries"), { recursive: true });
    mkdirSync(join(vault, "raw", "articles"), { recursive: true });

    const runDate = "2026-06-11";
    const runId = "2026-06-11T00-10-00+08-00";
    const evidencePath = `raw/articles/${runDate}-agent-memory-trends-evidence-${runId}.md`;
    const digestPath = `queries/${runDate}-agent-memory-trends-digest.md`;
    const manifestPath = `.skillwiki/agent-memory-trends/${runDate}-run.json`;
    const inputPath = join(vault, ".skillwiki", "agent-memory-trends", `${runDate}-input.json`);

    const result = await runAgentMemoryTrendsCli(["daily", "--generate-only", "--vault", vault, "--repo", "/repo", "--config", "/config.yaml"], {
      cwd: "/repo",
      env: {
        AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://kuma.example/push",
      },
      now: new Date("2026-06-11T00:10:00+08:00"),
      readFile: () => CONFIG,
      collectGithubCandidates: async () => ({ ok: true, data: {
        rateLimit: { resources: { core: { remaining: 5000, limit: 5000, reset: 1 }, search: { remaining: 30, limit: 30, reset: 1 } } },
        apiCallsUsed: 12,
        rawCandidateCount: 1,
        selectedCandidates: [selectedCandidate()],
        runSummary: { rawCandidateCount: 1, selectedCandidateCount: 1, apiCallsUsed: 12 },
      } }),
      collectDuplicateSignals: () => ({ ok: true, data: { existingTasks: [], activeWork: [], recentDigests: [] } }),
      writeAgentInput: () => ({ ok: true, data: { path: inputPath } }),
      runSynthesis: async (input) => {
        calls.push("synthesis");
        writeFileSync(join(vault, evidencePath), "# Evidence\n", "utf8");
        writeFileSync(join(vault, digestPath), "# Digest\n", "utf8");
        writeFileSync(join(vault, manifestPath), JSON.stringify({
          run_date: runDate,
          status: "success",
          changed_files: [evidencePath, digestPath, manifestPath],
          outputs: {
            evidence_path: evidencePath,
            digest_path: digestPath,
          },
          web_sources: [],
        }, null, 2) + "\n", "utf8");
        return {
          ok: true,
          data: {
            manifestPath: join(vault, manifestPath),
            outputLastMessagePath: input.outputLastMessagePath,
            stdout: "",
            stderr: "",
            output: { proposals: [] },
          },
        };
      },
      renderProposalCaptures: (input) => {
        calls.push("render");
        expect(input.manifestPath).toBe(manifestPath);
        return {
          ok: true,
          data: {
            renderedPaths: [],
            validationErrors: [],
            duplicateSuppressions: [],
          },
        };
      },
      refreshSessionBrief: async () => {
        calls.push("refresh-brief");
        return { ok: true, data: { filesWritten: ["meta/latest-session-brief.md"] } };
      },
      publishGeneratedChanges: async () => {
        calls.push("publish");
        return { ok: true, data: { baseCommit: "abc123", changedFiles: [], commitMessage: "noop" } };
      },
      maybeSendHeartbeat: async () => {
        calls.push("heartbeat");
        return { ok: true, data: { status: "sent", url: "https://kuma.example/push" } };
      },
      writeRunState: () => {
        calls.push("write-state");
        return {
          ok: true,
          data: {
            runStatePath: join(vault, manifestPath),
            latestRunPath: join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json"),
          },
        };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected daily success");
    expect(calls).toEqual(["synthesis", "render"]);
    expect(result.result.data.humanHint).toContain("daily: ok (generate-only)");
    expect(result.result.data.mutations).toEqual([
      inputPath,
      ".skillwiki/agent-memory-trends/2026-06-11-input.json",
      ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
      digestPath,
      evidencePath,
    ]);
    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    const latest = JSON.parse(readFileSync(join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json"), "utf8"));
    expect(manifest.outputs.latest_run_path).toBe(".skillwiki/agent-memory-trends/latest-run.json");
    expect(manifest.changed_files).toEqual([
      ".skillwiki/agent-memory-trends/2026-06-11-input.json",
      ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
      digestPath,
      evidencePath,
    ]);
    expect(latest).toEqual(manifest);
  });

  it("restores last-op scratch state after the default session brief refresh", async () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-cli-"));
    const lastOpPath = join(vault, ".skillwiki", "last-op.json");
    const previousLastOp = '[{"operation":"ingest","summary":"previous op","files":[],"timestamp":"2026-06-10T00:00:00Z"}]\n';
    mkdirSync(join(vault, ".skillwiki"), { recursive: true });
    writeFileSync(lastOpPath, previousLastOp, "utf8");

    const calls: string[] = [];
    const result = await runAgentMemoryTrendsCli(["daily", "--vault", vault, "--repo", "/repo", "--config", "/config.yaml"], {
      cwd: "/repo",
      env: {},
      now: new Date("2026-06-11T00:10:00+08:00"),
      readFile: () => CONFIG,
      collectGithubCandidates: async () => ({ ok: true, data: {
        rateLimit: { resources: { core: { remaining: 5000, limit: 5000, reset: 1 }, search: { remaining: 30, limit: 30, reset: 1 } } },
        apiCallsUsed: 12,
        rawCandidateCount: 1,
        selectedCandidates: [selectedCandidate()],
        runSummary: { rawCandidateCount: 1, selectedCandidateCount: 1, apiCallsUsed: 12 },
      } }),
      collectDuplicateSignals: () => ({ ok: true, data: { existingTasks: [], activeWork: [], recentDigests: [] } }),
      writeAgentInput: () => ({ ok: true, data: { path: join(vault, ".skillwiki/agent-memory-trends/2026-06-11-input.json") } }),
      runSynthesis: async (input) => ({
        ok: true,
        data: {
          manifestPath: join(vault, ".skillwiki/agent-memory-trends/2026-06-11-run.json"),
          outputLastMessagePath: input.outputLastMessagePath,
          stdout: "",
          stderr: "",
          output: { proposals: [] },
        },
      }),
      renderProposalCaptures: () => ({
        ok: true,
        data: {
          renderedPaths: [],
          validationErrors: [],
          duplicateSuppressions: [],
        },
      }),
      runCommand: async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        expect(command).toBe("skillwiki");
        expect(args).toEqual(["session-brief", vault, "--project", "llm-wiki", "--write"]);
        writeFileSync(lastOpPath, '[{"operation":"session-brief"}]\n', "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      listTrackedRawPaths: async () => ({ ok: true, data: [] }),
      publishGeneratedChanges: async () => ({
        ok: true,
        data: {
          baseCommit: "abc123",
          changedFiles: [],
          commitMessage: "research(agent-memory): daily digest 2026-06-11",
        },
      }),
      maybeSendHeartbeat: async () => ({ ok: true, data: { status: "skipped", reason: "heartbeat URL missing" } }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(calls).toEqual([`skillwiki session-brief ${vault} --project llm-wiki --write`]);
    expect(readFileSync(lastOpPath, "utf8")).toBe(previousLastOp);
  });

  it("wires publish through the publisher gate and heartbeat when not dry-run", async () => {
    const calls: string[] = [];
    const result = await runAgentMemoryTrendsCli(["publish", "--vault", "/vault", "--manifest", ".skillwiki/agent-memory-trends/2026-06-11-run.json"], {
      cwd: "/repo",
      env: {
        AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://kuma.example/push",
      },
      now: new Date("2026-06-11T00:10:00+08:00"),
      listTrackedRawPaths: async (vault) => {
        expect(vault).toBe("/vault");
        return { ok: true, data: ["raw/articles/2026-06-10-agent-memory-trends-evidence.md"] };
      },
      publishGeneratedChanges: async (input) => {
        calls.push(`publish:${input.manifestPath}`);
        expect(input.existingRawPaths).toEqual(["raw/articles/2026-06-10-agent-memory-trends-evidence.md"]);
        return {
          ok: true,
          data: {
            baseCommit: "abc123",
            changedFiles: ["queries/2026-06-11-agent-memory-trends-digest.md"],
            commitMessage: "research(agent-memory): daily digest 2026-06-11",
          },
        };
      },
      maybeSendHeartbeat: async (input) => {
        calls.push(`heartbeat:${input.pushSucceeded ? "pushed" : "not-pushed"}`);
        return { ok: true, data: { status: "sent", url: input.url ?? "" } };
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    expect(calls).toEqual([
      "publish:.skillwiki/agent-memory-trends/2026-06-11-run.json",
      "heartbeat:pushed",
    ]);
    if (!result.result.ok) throw new Error("expected publish success");
    expect(result.result.data.mutations).toEqual(["queries/2026-06-11-agent-memory-trends-digest.md"]);
  });
});
