import { describe, expect, it } from "vitest";
import { parseResearchConfig } from "../src/config.js";
import {
  classifyEvidenceQuality,
  collectGithubCandidates,
  type GhRunResult,
  type GhRunner,
} from "../src/github.js";

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

const LANE_CONFIG = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: 100
  max_queries: 4
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: daily_fresh
      label: Daily fresh
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 10
        min_forks: 0
        min_evidence_families: 2
        allow_multi_query_exception: true
      queries:
        - id: daily-memory
          label: Daily coding-agent memory
          query: coding agent memory in:name,description,readme
    - id: weekly_momentum
      label: Weekly momentum
      window_days: 7
      date_field: pushed
      sort: stars
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 50
        min_forks: 5
        min_evidence_families: 2
      queries:
        - id: weekly-checkpoints
          label: Weekly checkpoint memory
          query: checkpoint memory coding agent in:name,description,readme
    - id: monthly_authority
      label: Monthly authority
      window_days: 30
      date_field: pushed
      sort: stars
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 100
        min_forks: 10
        min_evidence_families: 2
      queries:
        - id: monthly-workflow
          label: Monthly workflow distillation
          query: workflow distillation agent memory in:name,description,readme
    - id: emerging
      label: Emerging evidence
      window_days: 30
      date_field: created
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 3
        allow_strong_evidence_exception: true
      queries:
        - id: emerging-local-search
          label: Emerging local search memory
          query: local search database agent trajectory memory in:name,description,readme
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;

describe("agent-memory-trends GitHub collector", () => {
  it("classifies shallow markers separately from actionable implementation evidence", () => {
    const marker = classifyEvidenceQuality({
      name: "mcp-memory-marker",
      fullName: "acme/mcp-memory-marker",
      canonicalUrl: "https://github.com/acme/mcp-memory-marker",
      description: "MCP agent memory",
      topics: ["agent-memory", "mcp"],
      readmeText: "# MCP Memory\n\nMCP agent memory.",
      stargazersCount: 25,
      forksCount: 2,
      pushedAt: "2026-06-10T00:00:00Z",
      archived: false,
    });

    expect(marker).toMatchObject({
      depth: "metadata_only",
      sourceInspectionRecommended: false,
      signals: expect.arrayContaining(["mcp", "agent-memory"]),
    });

    const featureSurface = classifyEvidenceQuality({
      name: "adaptive-memory-collector",
      fullName: "acme/adaptive-memory-collector",
      canonicalUrl: "https://github.com/acme/adaptive-memory-collector",
      description: "Coding agent memory collector",
      topics: ["agent-memory"],
      readmeText: [
        "# Adaptive Memory Collector",
        "",
        "Collects source-backed agent memory pages with adaptive selector behavior and dynamic fetcher routing.",
      ].join("\n"),
      stargazersCount: 120,
      forksCount: 12,
      pushedAt: "2026-06-10T00:00:00Z",
      archived: false,
    });

    expect(featureSurface).toMatchObject({
      depth: "feature_surface",
      sourceInspectionRecommended: true,
      signals: expect.arrayContaining(["adaptive", "selector", "fetcher"]),
    });

    const implementationSurface = classifyEvidenceQuality({
      name: "agent-memory-cli",
      fullName: "acme/agent-memory-cli",
      canonicalUrl: "https://github.com/acme/agent-memory-cli",
      description: "Coding agent memory CLI and MCP integration",
      topics: ["agent-memory", "mcp"],
      readmeText: [
        "# Agent Memory CLI",
        "",
        "Ships a CLI, MCP server, parser adapters, plugin registry workflow, and tests for source capture.",
      ].join("\n"),
      stargazersCount: 220,
      forksCount: 24,
      pushedAt: "2026-06-10T00:00:00Z",
      archived: false,
    });

    expect(implementationSurface).toMatchObject({
      depth: "integration_surface",
      sourceInspectionRecommended: true,
      signals: expect.arrayContaining(["cli", "mcp", "parser", "adapter", "plugin", "workflow", "tests"]),
    });
  });

  it("preflights gh auth, checks rate limits, searches repositories, fetches READMEs, and respects budgets", async () => {
    const parsed = parseResearchConfig(CONFIG, "github-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = args[args.indexOf("-f") + 1]?.replace(/^q=/, "") ?? "unknown";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            total_count: 6,
            items: Array.from({ length: 6 }, (_, index) => ({
              name: `memory-${query.slice(0, 8)}-${index}`,
              full_name: `acme/memory-${query.slice(0, 8)}-${index}`,
              html_url: `https://github.com/acme/memory-${query.slice(0, 8)}-${index}`,
              description: "MCP agent memory with Markdown, SQLite, and session continuity.",
              topics: ["agent-memory", "mcp", "markdown", "sqlite"],
              stargazers_count: 100 + index,
              forks_count: 20,
              pushed_at: "2026-06-10T00:00:00Z",
              archived: false,
            })),
          }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        const readme = [
          "# Local Agent Memory",
          "",
          "Markdown knowledge base, local-first sync, Codex and Claude memory hooks.",
          "",
          "Irrelevant implementation notes. ".repeat(200),
        ].join("\n");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(readme).toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-11T00:10:00+08:00"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    expect(calls[0]).toEqual(["auth", "status"]);
    expect(calls[1]).toEqual(["api", "rate_limit"]);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories")).toHaveLength(10);
    expect(calls.some((args) => args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme"))).toBe(
      true
    );
    expect(result.data.apiCallsUsed).toBeLessThanOrEqual(100);
    expect(result.data.rawCandidateCount).toBe(50);
    expect(result.data.selectedCandidates).toHaveLength(10);
    expect(result.data.selectedCandidates[0].readmeEvidence).toEqual([
      {
        sourceUrl: expect.stringMatching(/^https:\/\/github\.com\/acme\/memory-.*#readme$/),
        excerpt: "Markdown knowledge base, local-first sync, Codex and Claude memory hooks.",
        supportsClaim: "README evidence mentions coding-agent memory or workflow implementation signals.",
        confidence: "medium",
      },
    ]);
    const readmeEvidence = result.data.selectedCandidates[0].readmeEvidence ?? [];
    expect(readmeEvidence[0]?.excerpt.length).toBeLessThanOrEqual(600);
    expect(result.data.selectedCandidates[0].readmeText.length).toBeGreaterThan(
      readmeEvidence[0]?.excerpt.length ?? 0
    );
    expect(result.data.selectedCandidates[0].evidenceQuality).toMatchObject({
      depth: "integration_surface",
      sourceInspectionRecommended: true,
      signals: expect.arrayContaining(["markdown", "sync", "hook"]),
    });
    expect(result.data.rateLimit.resources.search.remaining).toBe(29);
    expect(result.data.runSummary).toMatchObject({
      rawCandidateCount: 50,
      selectedCandidateCount: 10,
      apiCallsUsed: result.data.apiCallsUsed,
    });
    expect(result.data.laneDiagnostics).toHaveLength(1);
    expect(result.data.laneDiagnostics[0]).toMatchObject({
      laneId: "legacy",
      configuredQueryCount: 10,
      executedQueryCount: 10,
      searchResultCount: 60,
      qualityPassedCount: 50,
      selectedCount: 10,
    });
  });

  it("collects by lane, merges duplicate repositories, filters weak daily noise, and recalls MiMo-class evidence generically", async () => {
    const parsed = parseResearchConfig(LANE_CONFIG, "lane-github-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = (args.find((arg) => arg.startsWith("q=")) ?? "").replace(/^q=/, "");
        const items = [
          repo({
            name: "MiMo-Code",
            full_name: "XiaomiMiMo/MiMo-Code",
            html_url: "https://github.com/XiaomiMiMo/MiMo-Code",
            description: null,
            topics: [],
            stargazers_count: 7316,
            forks_count: 582,
            pushed_at: "2026-06-11T14:29:00Z",
          }),
        ];
        if (query.includes("checkpoint memory") || query.includes("workflow distillation")) {
          items.push(
            repo({
              name: "awesome-go",
              full_name: "avelino/awesome-go",
              html_url: "https://github.com/avelino/awesome-go",
              description: "A curated list of Go frameworks, libraries, workflow tools, databases, and search packages.",
              topics: ["go", "awesome-list", "database", "search"],
              stargazers_count: 150000,
              forks_count: 12000,
              pushed_at: "2026-06-12T10:00:00Z",
            })
          );
        }
        if (query.includes("coding agent memory")) {
          items.push(
            repo({
              name: "fresh-demo",
              full_name: "noise/fresh-demo",
              html_url: "https://github.com/noise/fresh-demo",
              description: "Fresh project with no implementation evidence.",
              topics: [],
              stargazers_count: 0,
              forks_count: 0,
              pushed_at: "2026-06-12T23:58:00Z",
            })
          );
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ total_count: items.length, items }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        const fullName = args[1].replace(/^\/repos\//, "").replace(/\/readme$/, "");
        const readme =
          fullName.toLowerCase() === "xiaomimimo/mimo-code"
            ? [
                "# MiMo Code",
                "",
                "An autonomous coding agent workflow with checkpoint memory, context consolidation, dream and distill loops, reusable skills, subagents, goal judge evaluation, and local search over agent trajectories.",
              ].join("\n")
            : fullName.toLowerCase() === "avelino/awesome-go"
              ? [
                  "# Awesome Go",
                  "",
                  "A curated list of workflow tools, database libraries, search packages, benchmarks, and local storage projects.",
                  "",
                  "## Contents",
                  "",
                  "- Database",
                  "- Workflow Frameworks",
                  "",
                  "## Artificial Intelligence",
                  "",
                  "- hotplex - AI Agent runtime engine with long-lived sessions for Claude Code, OpenCode and other CLI AI tools.",
                  "- veil - Local HTTPS proxy that hides API credentials from AI coding agents with SQLite audit logs.",
                  "- dakera-go - Agent memory server SDK with memory store and recall APIs.",
                ].join("\n")
            : "Small wrapper with a recent push.";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(readme).toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    const searchCalls = calls.filter((args) => args[0] === "api" && args[1] === "--method" && args[3] === "/search/repositories");
    expect(searchCalls).toHaveLength(4);
    expect(searchCalls[0]).toEqual(expect.arrayContaining(["q=coding agent memory in:name,description,readme pushed:>=2026-06-12", "sort=updated", "order=desc", "per_page=10"]));
    expect(searchCalls[1]).toEqual(expect.arrayContaining(["q=checkpoint memory coding agent in:name,description,readme pushed:>=2026-06-06", "sort=stars", "order=desc", "per_page=10"]));
    expect(searchCalls[3]).toEqual(expect.arrayContaining(["q=local search database agent trajectory memory in:name,description,readme created:>=2026-05-14"]));

    expect(result.data.selectedCandidates.some((candidate) => candidate.fullName === "noise/fresh-demo")).toBe(false);
    expect(result.data.selectedCandidates.some((candidate) => candidate.fullName === "avelino/awesome-go")).toBe(false);
    const mimo = result.data.selectedCandidates.find((candidate) => candidate.fullName === "XiaomiMiMo/MiMo-Code");
    expect(mimo).toBeTruthy();
    expect(mimo?.laneIds).toEqual(["daily_fresh", "weekly_momentum", "monthly_authority", "emerging"]);
    expect(mimo?.queryIds).toEqual(["daily-memory", "weekly-checkpoints", "monthly-workflow", "emerging-local-search"]);
    expect(mimo?.qualityGate).toBe("passed");
    expect(mimo?.evidenceFamilies).toEqual(
      expect.arrayContaining(["coding_agent", "memory_state", "workflow_distillation", "skills_subagents", "goal_judge", "knowledge_store"])
    );
    expect(mimo?.score.reasons.join("\n")).toContain("lane evidence");
    expect(mimo?.score.reasons.join("\n")).toContain("authority/momentum");

    expect(result.data.laneDiagnostics).toEqual([
      expect.objectContaining({ laneId: "daily_fresh", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, qualityPassedCount: 1, selectedCount: 1 }),
      expect.objectContaining({ laneId: "weekly_momentum", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, qualityPassedCount: 1, selectedCount: 1 }),
      expect.objectContaining({ laneId: "monthly_authority", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, qualityPassedCount: 1, selectedCount: 1 }),
      expect.objectContaining({ laneId: "emerging", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 1, mergedCandidateCount: 1, qualityPassedCount: 1, selectedCount: 1 }),
    ]);
  });
it("runs unqualified count queries only in diagnostic mode and fills the pre-date-filter totals per lane", async () => {
    const parsed = parseResearchConfig(LANE_CONFIG, "lane-github-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = (args.find((arg) => arg.startsWith("q=")) ?? "").replace(/^q=/, "");
        const items = [
          repo({
            name: "MiMo-Code",
            full_name: "XiaomiMiMo/MiMo-Code",
            html_url: "https://github.com/XiaomiMiMo/MiMo-Code",
            description: null,
            topics: [],
            stargazers_count: 7316,
            forks_count: 582,
            pushed_at: "2026-06-11T14:29:00Z",
          }),
        ];
        if (query.includes("checkpoint memory") || query.includes("workflow distillation")) {
          items.push(
            repo({
              name: "awesome-go",
              full_name: "avelino/awesome-go",
              html_url: "https://github.com/avelino/awesome-go",
              description: "A curated list of Go frameworks, libraries, workflow tools, databases, and search packages.",
              topics: ["go", "awesome-list", "database", "search"],
              stargazers_count: 150000,
              forks_count: 12000,
              pushed_at: "2026-06-12T10:00:00Z",
            })
          );
        }
        if (query.includes("coding agent memory")) {
          items.push(
            repo({
              name: "fresh-demo",
              full_name: "noise/fresh-demo",
              html_url: "https://github.com/noise/fresh-demo",
              description: "Fresh project with no implementation evidence.",
              topics: [],
              stargazers_count: 0,
              forks_count: 0,
              pushed_at: "2026-06-12T23:58:00Z",
            })
          );
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ total_count: items.length, items }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        const fullName = args[1].replace(/^\/repos\//, "").replace(/\/readme$/, "");
        const readme =
          fullName.toLowerCase() === "xiaomimimo/mimo-code"
            ? [
                "# MiMo Code",
                "",
                "An autonomous coding agent workflow with checkpoint memory, context consolidation, dream and distill loops, reusable skills, subagents, goal judge evaluation, and local search over agent trajectories.",
              ].join("\n")
            : fullName.toLowerCase() === "avelino/awesome-go"
              ? [
                  "# Awesome Go",
                  "",
                  "A curated list of workflow tools, database libraries, search packages, benchmarks, and local storage projects.",
                  "",
                  "## Contents",
                  "",
                  "- Database",
                ].join("\n")
            : "Small wrapper with a recent push.";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(readme).toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const options = { runGh: runner, now: new Date("2026-06-13T00:00:00Z") };

    const normal = await collectGithubCandidates(parsed.data, options);
    expect(normal.ok).toBe(true);
    if (!normal.ok) throw new Error("expected collector success");
    // Ordinary collection runs no count queries, so API usage is unchanged
    // (auth status is free; rate_limit + 4 searches + 3 readmes).
    expect(calls.some((args) => args.some((arg) => arg === "per_page=1"))).toBe(false);
    expect(normal.data.apiCallsUsed).toBe(8);
    expect(normal.data.laneDiagnostics[0].unqualifiedTotalCount).toBeUndefined();

    calls.length = 0;
    const diagnosed = await collectGithubCandidates(parsed.data, { ...options, diagnostic: true });
    expect(diagnosed.ok).toBe(true);
    if (!diagnosed.ok) throw new Error("expected diagnostic collector success");
    const countCalls = calls.filter((args) => args.some((arg) => arg === "per_page=1"));
    expect(countCalls).toHaveLength(4);
    // The unqualified count query carries the raw query without the lane's date window.
    expect(countCalls[0]).toEqual(expect.arrayContaining(["q=coding agent memory in:name,description,readme"]));
    expect(countCalls[0].some((arg) => arg.startsWith("q=") && arg.includes(":>="))).toBe(false);
    expect(countCalls[0].some((arg) => arg.startsWith("sort="))).toBe(false);
    const diagnosedByLane = new Map(diagnosed.data.laneDiagnostics.map((lane) => [lane.laneId, lane]));
    expect(diagnosedByLane.get("daily_fresh")).toMatchObject({
      configuredQueryCount: 1,
      executedQueryCount: 1,
      unqualifiedTotalCount: 2,
      qualifiedTotalCount: 2,
      searchResultCount: 2,
      mergedCandidateCount: 2,
      readmeProcessedCount: 2,
      qualityPassedCount: 1,
      rawEligibleCount: 1,
      selectedCount: 1,
      mergedDuplicateCount: 0,
      budgetExhausted: false,
    });
    expect(diagnosedByLane.get("weekly_momentum")).toMatchObject({
      unqualifiedTotalCount: 2,
      qualifiedTotalCount: 2,
      searchResultCount: 2,
      mergedCandidateCount: 2,
      readmeProcessedCount: 2,
      qualityPassedCount: 1,
      mergedDuplicateCount: 1,
    });
    expect(diagnosedByLane.get("monthly_authority")).toMatchObject({
      unqualifiedTotalCount: 2,
      searchResultCount: 2,
      mergedCandidateCount: 2,
      mergedDuplicateCount: 2,
    });
    expect(diagnosedByLane.get("emerging")).toMatchObject({
      unqualifiedTotalCount: 1,
      searchResultCount: 1,
      mergedCandidateCount: 1,
      mergedDuplicateCount: 1,
    });
    expect(diagnosed.data.apiCallsUsed).toBe(12);
  });

  it("exposes budget exhaustion per lane when the API call budget cuts queries and README processing short", async () => {
    const parsed = parseResearchConfig(LANE_CONFIG.replace("api_call_budget: 100", "api_call_budget: 4"), "lane-github-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            total_count: 2,
            items: [
              repo({}),
              repo({ name: "other", full_name: "acme/other", html_url: "https://github.com/acme/other" }),
            ],
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    // rate_limit + daily + weekly + monthly search = 4 api calls; emerging is
    // cut by the budget and the readme loop is cut at the same ceiling.
    expect(result.data.apiCallsUsed).toBe(4);
    expect(result.data.laneDiagnostics).toEqual([
      expect.objectContaining({ laneId: "daily_fresh", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, readmeProcessedCount: 0, qualityPassedCount: 0, selectedCount: 0, mergedDuplicateCount: 0, budgetExhausted: true }),
      expect.objectContaining({ laneId: "weekly_momentum", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, readmeProcessedCount: 0, mergedDuplicateCount: 2, budgetExhausted: true }),
      expect.objectContaining({ laneId: "monthly_authority", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, readmeProcessedCount: 0, mergedDuplicateCount: 2, budgetExhausted: true }),
      expect.objectContaining({ laneId: "emerging", configuredQueryCount: 1, executedQueryCount: 0, searchResultCount: 0, mergedCandidateCount: 0, mergedDuplicateCount: 0, budgetExhausted: true }),
    ]);
  });

  it("reserves the diagnostic count-query pair inside the api call budget so it never exceeds the ceiling", async () => {
    const parsed = parseResearchConfig(LANE_CONFIG.replace("api_call_budget: 100", "api_call_budget: 4"), "lane-github-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            total_count: 2,
            items: [
              repo({}),
              repo({ name: "other", full_name: "acme/other", html_url: "https://github.com/acme/other" }),
            ],
          }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from("Small wrapper with a recent push.").toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
      diagnostic: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    // rate_limit = 1; the daily search+count pair fits (3), the weekly pair
    // would need 5 > 4 so it never starts; one README call stays inside the
    // ceiling: total 4 and never more.
    expect(result.data.apiCallsUsed).toBe(4);
    expect(result.data.apiCallsUsed).toBeLessThanOrEqual(4);
    expect(calls.filter((args) => args.some((arg) => arg === "per_page=1"))).toHaveLength(1);
    expect(result.data.laneDiagnostics).toEqual([
      expect.objectContaining({ laneId: "daily_fresh", configuredQueryCount: 1, executedQueryCount: 1, searchResultCount: 2, mergedCandidateCount: 2, readmeProcessedCount: 1, budgetExhausted: true }),
      expect.objectContaining({ laneId: "weekly_momentum", configuredQueryCount: 1, executedQueryCount: 0, searchResultCount: 0, mergedCandidateCount: 0, readmeProcessedCount: 0, budgetExhausted: true }),
      expect.objectContaining({ laneId: "monthly_authority", configuredQueryCount: 1, executedQueryCount: 0, searchResultCount: 0, mergedCandidateCount: 0, readmeProcessedCount: 0, budgetExhausted: true }),
      expect.objectContaining({ laneId: "emerging", configuredQueryCount: 1, executedQueryCount: 0, searchResultCount: 0, mergedCandidateCount: 0, readmeProcessedCount: 0, budgetExhausted: true }),
    ]);
  });

  it("paces diagnostic search calls across the Search quota reset so a 46-call run completes inside a 30-request window", async () => {
    const parsed = parseResearchConfig(searchWindowConfig(23, 100), "rate-window-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const startMs = Date.parse("2026-06-13T00:10:00Z");
    const { calls, runner } = createSearchWindowRunner(
      { remaining: 30, resetSec: startMs / 1000 + 120 },
      { remaining: 30, resetSec: startMs / 1000 + 240 }
    );
    const sleeps: number[] = [];
    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date(startMs),
      diagnostic: true,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      nowMs: () => startMs,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected diagnostic collector success");
    // 23 qualified + 23 unqualified count queries need 46 Search API calls;
    // the 30-request window cannot cover them, so the run waits for the
    // reset exactly once (reset + 5s buffer) instead of failing with 403s.
    expect(calls.filter((args) => args[0] === "api" && args[1] === "--method" && args[3] === "/search/repositories")).toHaveLength(46);
    expect(calls.filter((args) => args.some((arg) => arg === "per_page=1"))).toHaveLength(23);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(2);
    expect(sleeps).toEqual([120_000 + 5_000]);
    const rateLimitIndexes = calls
      .map((args, index) => (args[0] === "api" && args[1] === "rate_limit" ? index : -1))
      .filter((index) => index >= 0);
    // Exactly the 30-request window elapses before the single bounded recheck.
    expect(rateLimitIndexes[1] - rateLimitIndexes[0] - 1).toBe(30);
    expect(result.data.apiCallsUsed).toBe(48);
    expect(result.data.runSummary.apiCallsUsed).toBe(48);
    expect(result.data.laneDiagnostics[0]).toMatchObject({
      configuredQueryCount: 23,
      executedQueryCount: 23,
      budgetExhausted: false,
    });
  });

  it("interleaves README fetches round-robin across lanes so later lanes with merged candidates are not starved", async () => {
    // 3 lanes, each with 2 distinct merged candidates (6 total unique candidates).
    // API call budget is set so:
    // rate_limit = 1
    // 3 search queries = 3 calls
    // apiCallsUsed after search = 4
    // api_call_budget = 7 -> exactly 3 README calls remaining.
    // With 3 lanes and 3 remaining README calls, round-robin gives 1 README fetch to each lane!
    // Under old insertion-order monopoly, lane 1 got 2 READMEs, lane 2 got 1, lane 3 got 0.
    const configYaml = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: 7
  max_queries: 3
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: lane_a
      label: Lane A
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-a
          label: Query A
          query: agent memory a in:name,description,readme
    - id: lane_b
      label: Lane B
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-b
          label: Query B
          query: agent memory b in:name,description,readme
    - id: lane_c
      label: Lane C
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-c
          label: Query C
          query: agent memory c in:name,description,readme
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;
    const parsed = parseResearchConfig(configYaml, "fair-lane-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const readmeCalls: string[] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = (args.find((arg) => arg.startsWith("q=")) ?? "").replace(/^q=/, "");
        if (query.includes("agent memory a")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-a1", full_name: "test/cand-a1", html_url: "https://github.com/test/cand-a1" }),
                repo({ name: "cand-a2", full_name: "test/cand-a2", html_url: "https://github.com/test/cand-a2" }),
              ],
            }),
            stderr: "",
          };
        }
        if (query.includes("agent memory b")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-b1", full_name: "test/cand-b1", html_url: "https://github.com/test/cand-b1" }),
                repo({ name: "cand-b2", full_name: "test/cand-b2", html_url: "https://github.com/test/cand-b2" }),
              ],
            }),
            stderr: "",
          };
        }
        if (query.includes("agent memory c")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-c1", full_name: "test/cand-c1", html_url: "https://github.com/test/cand-c1" }),
                repo({ name: "cand-c2", full_name: "test/cand-c2", html_url: "https://github.com/test/cand-c2" }),
              ],
            }),
            stderr: "",
          };
        }
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        readmeCalls.push(args[1]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from("README content with tests and api.").toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    expect(readmeCalls).toEqual([
      "/repos/test/cand-a1/readme",
      "/repos/test/cand-b1/readme",
      "/repos/test/cand-c1/readme",
    ]);

    const laneDiagnostics = result.data.laneDiagnostics;
    const laneA = laneDiagnostics.find((l) => l.laneId === "lane_a")!;
    const laneB = laneDiagnostics.find((l) => l.laneId === "lane_b")!;
    const laneC = laneDiagnostics.find((l) => l.laneId === "lane_c")!;

    expect(laneA.readmeProcessedCount).toBe(1);
    expect(laneB.readmeProcessedCount).toBe(1);
    expect(laneC.readmeProcessedCount).toBe(1);

    // All 3 lanes have merged 2 candidates and processed 1 README: all hit README budget exhaustion
    expect(laneA.budgetExhausted).toBe(true);
    expect(laneA.readmeBudgetExhausted).toBe(true);
    expect(laneB.budgetExhausted).toBe(true);
    expect(laneB.readmeBudgetExhausted).toBe(true);
    expect(laneC.budgetExhausted).toBe(true);
    expect(laneC.readmeBudgetExhausted).toBe(true);
  });

  it("skips cleanly when a lane has zero merged candidates without infinite looping", async () => {
    // 3 lanes: lane_a has 2 candidates, lane_b has 0 candidates, lane_c has 2 candidates.
    // budget = 6 calls: rate_limit(1) + 3 queries(3) = 4, leaving 2 README calls.
    // Round-robin should process 1 from lane_a, skip lane_b, and 1 from lane_c.
    const configYaml = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: 6
  max_queries: 3
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: lane_a
      label: Lane A
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-a
          label: Query A
          query: agent memory a in:name,description,readme
    - id: lane_b
      label: Lane B
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-b
          label: Query B
          query: agent memory b in:name,description,readme
    - id: lane_c
      label: Lane C
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-c
          label: Query C
          query: agent memory c in:name,description,readme
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;
    const parsed = parseResearchConfig(configYaml, "zero-lane-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const readmeCalls: string[] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = (args.find((arg) => arg.startsWith("q=")) ?? "").replace(/^q=/, "");
        if (query.includes("agent memory a")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-a1", full_name: "test/cand-a1", html_url: "https://github.com/test/cand-a1" }),
                repo({ name: "cand-a2", full_name: "test/cand-a2", html_url: "https://github.com/test/cand-a2" }),
              ],
            }),
            stderr: "",
          };
        }
        if (query.includes("agent memory b")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ total_count: 0, items: [] }),
            stderr: "",
          };
        }
        if (query.includes("agent memory c")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-c1", full_name: "test/cand-c1", html_url: "https://github.com/test/cand-c1" }),
                repo({ name: "cand-c2", full_name: "test/cand-c2", html_url: "https://github.com/test/cand-c2" }),
              ],
            }),
            stderr: "",
          };
        }
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        readmeCalls.push(args[1]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from("README content with tests and api.").toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    expect(readmeCalls).toEqual([
      "/repos/test/cand-a1/readme",
      "/repos/test/cand-c1/readme",
    ]);

    const laneDiagnostics = result.data.laneDiagnostics;
    const laneA = laneDiagnostics.find((l) => l.laneId === "lane_a")!;
    const laneB = laneDiagnostics.find((l) => l.laneId === "lane_b")!;
    const laneC = laneDiagnostics.find((l) => l.laneId === "lane_c")!;

    expect(laneA.readmeProcessedCount).toBe(1);
    expect(laneB.readmeProcessedCount).toBe(0);
    expect(laneC.readmeProcessedCount).toBe(1);

    expect(laneB.budgetExhausted).toBe(false);
    expect(laneB.readmeBudgetExhausted).toBe(false);
  });

  it("falls back to lane YAML order deterministically when remaining README budget is smaller than lane count", async () => {
    // 3 lanes (lane_a, lane_b, lane_c), each with 1 candidate.
    // budget = 5 calls: rate_limit(1) + 3 queries(3) = 4.
    // Remaining README budget = 5 - 4 = 1.
    // 1 slot < 3 lanes. Fallback to lane YAML order deterministically gives 1 slot to lane_a.
    const configYaml = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: 5
  max_queries: 3
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: lane_a
      label: Lane A
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-a
          label: Query A
          query: agent memory a in:name,description,readme
    - id: lane_b
      label: Lane B
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-b
          label: Query B
          query: agent memory b in:name,description,readme
    - id: lane_c
      label: Lane C
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-c
          label: Query C
          query: agent memory c in:name,description,readme
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;
    const parsed = parseResearchConfig(configYaml, "yaml-order-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const readmeCalls: string[] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = (args.find((arg) => arg.startsWith("q=")) ?? "").replace(/^q=/, "");
        if (query.includes("agent memory a")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 1,
              items: [
                repo({ name: "cand-a1", full_name: "test/cand-a1", html_url: "https://github.com/test/cand-a1" }),
              ],
            }),
            stderr: "",
          };
        }
        if (query.includes("agent memory b")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 1,
              items: [
                repo({ name: "cand-b1", full_name: "test/cand-b1", html_url: "https://github.com/test/cand-b1" }),
              ],
            }),
            stderr: "",
          };
        }
        if (query.includes("agent memory c")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 1,
              items: [
                repo({ name: "cand-c1", full_name: "test/cand-c1", html_url: "https://github.com/test/cand-c1" }),
              ],
            }),
            stderr: "",
          };
        }
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        readmeCalls.push(args[1]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from("README content with tests and api.").toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    expect(readmeCalls).toEqual(["/repos/test/cand-a1/readme"]);
    expect(result.data.apiCallsUsed).toBe(5);

    const laneDiagnostics = result.data.laneDiagnostics;
    const laneA = laneDiagnostics.find((l) => l.laneId === "lane_a")!;
    const laneB = laneDiagnostics.find((l) => l.laneId === "lane_b")!;
    const laneC = laneDiagnostics.find((l) => l.laneId === "lane_c")!;

    expect(laneA.readmeProcessedCount).toBe(1);
    expect(laneA.budgetExhausted).toBe(false);
    expect(laneA.readmeBudgetExhausted).toBe(false);

    expect(laneB.readmeProcessedCount).toBe(0);
    expect(laneB.budgetExhausted).toBe(true);
    expect(laneB.readmeBudgetExhausted).toBe(true);

    expect(laneC.readmeProcessedCount).toBe(0);
    expect(laneC.budgetExhausted).toBe(true);
    expect(laneC.readmeBudgetExhausted).toBe(true);
  });

  it("fetches multi-lane URL exactly once while attributing readmeProcessedCount to all its lanes", async () => {
    // 2 lanes (lane_a, lane_b).
    // Shared candidate "cand-shared" appears in both lane_a and lane_b.
    // Also candidate "cand-a" only in lane_a, "cand-b" only in lane_b.
    // budget = 5 calls: rate_limit(1) + 2 queries(2) = 3 calls used.
    // 2 README calls remaining: 5 - 3 = 2.
    // When cand-shared is fetched, it should fetch README once, and increment readmeProcessedCount
    // for both lane_a and lane_b!
    const configYaml = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: 5
  max_queries: 2
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: lane_a
      label: Lane A
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-a
          label: Query A
          query: agent memory a in:name,description,readme
    - id: lane_b
      label: Lane B
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: q-b
          label: Query B
          query: agent memory b in:name,description,readme
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;
    const parsed = parseResearchConfig(configYaml, "multilane-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const readmeCalls: string[] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
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
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = (args.find((arg) => arg.startsWith("q=")) ?? "").replace(/^q=/, "");
        if (query.includes("agent memory a")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-shared", full_name: "test/cand-shared", html_url: "https://github.com/test/cand-shared" }),
                repo({ name: "cand-a", full_name: "test/cand-a", html_url: "https://github.com/test/cand-a" }),
              ],
            }),
            stderr: "",
          };
        }
        if (query.includes("agent memory b")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              total_count: 2,
              items: [
                repo({ name: "cand-shared", full_name: "test/cand-shared", html_url: "https://github.com/test/cand-shared" }),
                repo({ name: "cand-b", full_name: "test/cand-b", html_url: "https://github.com/test/cand-b" }),
              ],
            }),
            stderr: "",
          };
        }
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        readmeCalls.push(args[1]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from("README content with tests and api.").toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-13T00:00:00Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    // Exactly 2 readme calls allowed by budget (3 used before, budget 5 -> 2)
    // cand-shared is first round (lane_a has cand-shared, cand-a; lane_b has cand-shared, cand-b)
    // Round 0: lane_a picks cand-shared. Next lane_b: cand-shared already scheduled/fetched, picks cand-b.
    // Total unique README calls = 2.
    expect(readmeCalls).toHaveLength(2);
    expect(readmeCalls).toContain("/repos/test/cand-shared/readme");

    const laneA = result.data.laneDiagnostics.find((l) => l.laneId === "lane_a")!;
    const laneB = result.data.laneDiagnostics.find((l) => l.laneId === "lane_b")!;

    // Both lanes should have cand-shared attributed to readmeProcessedCount!
    expect(laneA.readmeProcessedCount).toBeGreaterThanOrEqual(1);
    expect(laneB.readmeProcessedCount).toBeGreaterThanOrEqual(1);
  });

  it("still stops the diagnostic run before exceeding the api budget when the reset wait adds a recheck call", async () => {
    const parsed = parseResearchConfig(searchWindowConfig(23, 47), "rate-window-budget-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const startMs = Date.parse("2026-06-13T00:10:00Z");
    const { calls, runner } = createSearchWindowRunner(
      { remaining: 30, resetSec: startMs / 1000 + 120 },
      { remaining: 30, resetSec: startMs / 1000 + 240 }
    );
    const sleeps: number[] = [];
    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date(startMs),
      diagnostic: true,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      nowMs: () => startMs,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected diagnostic collector success");
    // The 31st search call needs the reset wait (one recheck call); with a
    // 47 budget the last query pair no longer fits (46 + 2 > 47), so q23 is
    // cut while the total stays inside the ceiling, recheck included.
    expect(sleeps).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(2);
    expect(result.data.apiCallsUsed).toBe(46);
    expect(result.data.apiCallsUsed).toBeLessThanOrEqual(47);
    expect(result.data.laneDiagnostics[0]).toMatchObject({
      configuredQueryCount: 23,
      executedQueryCount: 22,
      budgetExhausted: true,
    });
  });

  it("fails the diagnostic run after one wait and one recheck instead of busy-looping when the Search quota never recovers", async () => {
    const parsed = parseResearchConfig(searchWindowConfig(1, 100), "rate-window-loop-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const startMs = Date.parse("2026-06-13T00:10:00Z");
    const { calls, runner } = createSearchWindowRunner(
      { remaining: 0, resetSec: startMs / 1000 + 60 },
      { remaining: 0, resetSec: startMs / 1000 + 120 }
    );
    const sleeps: number[] = [];
    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date(startMs),
      diagnostic: true,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      nowMs: () => startMs,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected exhausted Search quota to fail the diagnostic run");
    expect(result.error).toBe("GH_SEARCH_RATE_LIMIT");
    expect(sleeps).toEqual([60_000 + 5_000]);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(2);
    expect(calls.some((args) => args[0] === "api" && args[1] === "--method" && args[3] === "/search/repositories")).toBe(false);
  });

  it("refuses a quota recheck that cannot fit a tight api budget and completes at the exact ceiling when it can", async () => {
    // Initial remaining 1: the unqualified count query hits the boundary
    // mid-pair. With budget 3 the recheck plus the count call cannot fit,
    // so the run fails honestly instead of exceeding the budget.
    const tight = parseResearchConfig(searchWindowConfig(1, 3), "rate-window-tight-budget-test.yaml");
    if (!tight.ok) throw new Error("expected config to parse");
    const startMs = Date.parse("2026-06-13T00:10:00Z");
    const tightRunner = createSearchWindowRunner(
      { remaining: 1, resetSec: startMs / 1000 + 60 },
      { remaining: 30, resetSec: startMs / 1000 + 120 }
    );
    const tightSleeps: number[] = [];
    const tightResult = await collectGithubCandidates(tight.data, {
      runGh: tightRunner.runner,
      now: new Date(startMs),
      diagnostic: true,
      sleep: async (ms: number) => {
        tightSleeps.push(ms);
      },
      nowMs: () => startMs,
    });
    expect(tightResult.ok).toBe(false);
    if (tightResult.ok) throw new Error("expected tight budget to refuse the recheck");
    expect(tightResult.error).toBe("GH_SEARCH_RATE_LIMIT");
    expect(tightSleeps).toEqual([]);
    expect(tightRunner.calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(1);

    // Budget 4 fits the recheck plus the count call: the same run waits
    // once and lands exactly on the ceiling without exceeding it.
    const exact = parseResearchConfig(searchWindowConfig(1, 4), "rate-window-exact-budget-test.yaml");
    if (!exact.ok) throw new Error("expected config to parse");
    const exactRunner = createSearchWindowRunner(
      { remaining: 1, resetSec: startMs / 1000 + 60 },
      { remaining: 30, resetSec: startMs / 1000 + 120 }
    );
    const exactSleeps: number[] = [];
    const exactResult = await collectGithubCandidates(exact.data, {
      runGh: exactRunner.runner,
      now: new Date(startMs),
      diagnostic: true,
      sleep: async (ms: number) => {
        exactSleeps.push(ms);
      },
      nowMs: () => startMs,
    });
    expect(exactResult.ok).toBe(true);
    if (!exactResult.ok) throw new Error("expected exact-budget diagnostic success");
    expect(exactSleeps).toEqual([60_000 + 5_000]);
    expect(exactResult.data.apiCallsUsed).toBe(4);
    expect(exactResult.data.laneDiagnostics[0]).toMatchObject({ executedQueryCount: 1, budgetExhausted: false });
  });

  it("keeps ordinary collection free of search-quota waits, rechecks, and added calls even when the Search window is exhausted", async () => {
    const parsed = parseResearchConfig(searchWindowConfig(23, 100), "rate-window-ordinary-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const startMs = Date.parse("2026-06-13T00:10:00Z");
    const { calls, runner } = createSearchWindowRunner(
      { remaining: 0, resetSec: startMs / 1000 + 60 },
      { remaining: 0, resetSec: startMs / 1000 + 120 }
    );
    const sleeps: number[] = [];
    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date(startMs),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      nowMs: () => startMs,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ordinary collector success");
    expect(sleeps).toEqual([]);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "rate_limit")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "--method" && args[3] === "/search/repositories")).toHaveLength(23);
    expect(calls.some((args) => args.some((arg) => arg === "per_page=1"))).toBe(false);
    expect(result.data.apiCallsUsed).toBe(24);
  });
});

/** Single-lane config with `queryCount` queries, each needing 2 diagnostic Search calls. */
function searchWindowConfig(queryCount: number, apiCallBudget: number): string {
  const queries = Array.from({ length: queryCount }, (_, index) => {
    const id = `q${String(index + 1).padStart(2, "0")}`;
    return `        - { id: ${id}, label: ${id}, query: "memory ${id}" }`;
  }).join("\n");
  return `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: ${apiCallBudget}
  max_queries: 24
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: rate_limit_window
      label: Rate limit window
      window_days: 7
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 0
      queries:
${queries}
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;
}

function createSearchWindowRunner(
  initial: { remaining: number; resetSec: number },
  recheck: { remaining: number; resetSec: number }
): { calls: string[][]; runner: GhRunner } {
  const calls: string[][] = [];
  const runner: GhRunner = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "auth" && args[1] === "status") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args[1] === "rate_limit") {
      const recheckCount = calls.filter((call) => call[0] === "api" && call[1] === "rate_limit").length - 1;
      const state = recheckCount > 0 ? recheck : initial;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          resources: {
            core: { remaining: 4900, limit: 5000, reset: state.resetSec + 3600 },
            search: { remaining: state.remaining, limit: 30, reset: state.resetSec },
          },
        }),
        stderr: "",
      };
    }
    if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
      return { exitCode: 0, stdout: JSON.stringify({ total_count: 0, items: [] }), stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, runner };
}

function repo(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "repo",
    full_name: "acme/repo",
    html_url: "https://github.com/acme/repo",
    description: "Agent memory",
    topics: ["agent-memory"],
    stargazers_count: 100,
    forks_count: 10,
    pushed_at: "2026-06-10T00:00:00Z",
    archived: false,
    ...overrides,
  };
}
