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
  function successfulDoctorContext() {
    const toolCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const ghCalls: string[][] = [];
    return {
      toolCalls,
      ghCalls,
      context: {
        cwd: "/repo",
        env: {
          AGENT_MEMORY_TRENDS_HEARTBEAT_URL: "https://kuma.example/push",
        },
        now: new Date("2026-06-11T00:10:00Z"),
        readFile: (path: string) => {
          expect(path).toBe("/config.yaml");
          return CONFIG;
        },
        pathExists: (path: string) => path === "/vault" || path === "/repo",
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
        runCommand: async (command: string, args: string[], options: { cwd: string }) => {
          toolCalls.push({ command, args, cwd: options.cwd });
          if (command === "git" && args.join(" ") === "-C /vault status --short") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "-C /vault push --dry-run origin main") {
            return { exitCode: 0, stdout: "Everything up-to-date", stderr: "" };
          }
          if (command === "codex" && args.join(" ") === "doctor") {
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
      "codex doctor",
      "skillwiki doctor",
      "git -C /vault status --short",
      "git -C /vault push --dry-run origin main",
    ]);
    expect(result.result.data.humanHint).toContain("doctor: ok");
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

  it("wires daily --dry-run through collect, Codex synthesis, run-state, and skips publish plus heartbeat", async () => {
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
      runCodexSynthesis: async (input) => {
        calls.push(`codex:${input.input.runId}`);
        return { ok: true, data: { manifestPath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json", stdout: "", stderr: "" } };
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
    expect(calls).toEqual(["codex:2026-06-11T00-10-00+08-00"]);
    expect(result.result.data.mutations).toContain("/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json");
    expect(result.result.data.humanHint).toContain("daily: ok (dry-run)");
  });

  it("wires live daily through publish without rewriting run-state after the publish commit", async () => {
    const calls: string[] = [];
    const evidencePath = "raw/articles/2026-06-11-agent-memory-trends-evidence-2026-06-11T00-10-00+08-00.md";
    const publishedFiles = [
      ".skillwiki/agent-memory-trends/2026-06-11-input.json",
      ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      ".skillwiki/agent-memory-trends/latest-run.json",
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
      runCodexSynthesis: async () => {
        calls.push("codex");
        return { ok: true, data: { manifestPath: "/vault/.skillwiki/agent-memory-trends/2026-06-11-run.json", stdout: "", stderr: "" } };
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
    expect(calls).toEqual(["codex", "publish", "heartbeat"]);
    expect(result.result.data.mutations).toEqual([
      "/vault/.skillwiki/agent-memory-trends/2026-06-11-input.json",
      ...publishedFiles,
    ]);
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
