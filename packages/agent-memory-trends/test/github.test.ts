import { describe, expect, it } from "vitest";
import { parseResearchConfig } from "../src/config.js";
import { collectGithubCandidates, type GhRunResult, type GhRunner } from "../src/github.js";

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
    expect(result.data.rateLimit.resources.search.remaining).toBe(29);
    expect(result.data.runSummary).toMatchObject({
      rawCandidateCount: 50,
      selectedCandidateCount: 10,
      apiCallsUsed: result.data.apiCallsUsed,
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
  });
});

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
